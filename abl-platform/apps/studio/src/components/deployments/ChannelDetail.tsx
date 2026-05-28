/**
 * ChannelDetail Component
 *
 * Full-width detail view for a single SDK channel.
 * Sections: Header, Widget Config, Preview & Testing, Embed Code, Danger Zone.
 */

import { useState, useEffect, useMemo } from 'react';
import {
  ArrowLeft,
  Globe,
  Smartphone,
  Phone,
  Server,
  MessageSquare,
  Mic,
  Lock,
  ExternalLink,
  Plus,
  RefreshCw,
  Copy,
  Check,
  Trash2,
  Loader2,
  Info,
  AlertTriangle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Toggle } from '../ui/Toggle';
import { Input } from '../ui/Input';
import { CodeBlock } from '../ui/CodeBlock';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import { updateChannel, deleteChannel, type SDKChannel } from '../../api/channels';
import { fetchDeployments, type Deployment } from '../../api/deployments';
import { apiFetch } from '../../lib/api-client';
import { fetchSdkEmbedCode, SDK_EMBED_FETCH_ERROR } from '../../lib/sdk-embed';
import { useAuthStore } from '../../store/auth-store';
import { useNavigationStore } from '../../store/navigation-store';
import { AUTO_RESOLVE_DEPLOYMENT_LABEL, ENVIRONMENT_OPTIONS } from './channels/channel-utils';
import { buildSdkChannelBindingUpdate } from './channels/channel-binding-utils';

interface ChannelDetailProps {
  projectId: string;
  channel: SDKChannel;
  deploymentLabel?: string;
  apiKeyPrefix?: string;
  onBack: () => void;
  onUpdated: () => Promise<void>;
  onDeleted: () => void;
}

const channelTypeIcons: Record<string, React.ReactNode> = {
  web: <Globe className="w-5 h-5" />,
  mobile_ios: <Smartphone className="w-5 h-5" />,
  mobile_android: <Smartphone className="w-5 h-5" />,
  voice: <Phone className="w-5 h-5" />,
  voice_livekit: <Phone className="w-5 h-5" />,
  voice_twilio: <Phone className="w-5 h-5" />,
  api: <Server className="w-5 h-5" />,
};

const MODE_IDS = ['chat', 'voice', 'unified'] as const;
const MODE_ICONS = { chat: MessageSquare, voice: Mic, unified: Globe } as const;
const POSITION_IDS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const;
const PIPELINE_IDS = ['pipeline', 'realtime', 'auto'] as const;

function parseConfig(config: Record<string, unknown> | undefined | null) {
  const c = config || {};
  return {
    mode: (c.mode as string) || 'chat',
    position: (c.position as string) || 'bottom-right',
    chatEnabled: c.chatEnabled !== false,
    voiceEnabled: !!c.voiceEnabled,
    welcomeMessage: (c.welcomeMessage as string) || '',
    placeholderText: (c.placeholderText as string) || '',
    voicePipeline: (c.voicePipeline as string) || 'pipeline',
    asrVendor: (c.asrVendor as string) || 'deepgram',
    asrServiceInstanceId: c.asrServiceInstanceId as string | undefined,
    ttsVendor: (c.ttsVendor as string) || 'elevenlabs',
    ttsServiceInstanceId: c.ttsServiceInstanceId as string | undefined,
  };
}

export function ChannelDetail({
  projectId,
  channel,
  deploymentLabel,
  apiKeyPrefix,
  onBack,
  onUpdated,
  onDeleted,
}: ChannelDetailProps) {
  const t = useTranslations('deployments.channel_detail');
  const tType = useTranslations('deployments.channel_type_labels');
  const config = (channel.config ?? {}) as Record<string, unknown>;
  const initial = useMemo(() => parseConfig(config), [config]);

  const modeOptions = MODE_IDS.map((id) => ({
    id,
    label: t(`mode_${id}`),
    icon: MODE_ICONS[id],
  }));

  const positionOptions = POSITION_IDS.map((id) => ({
    id,
    label: t(`position_${id.replace('-', '_')}`),
  }));

  const voicePipelineOptions = PIPELINE_IDS.map((id) => ({
    id,
    label: t(`pipeline_${id}`),
    description: t(`pipeline_${id}_description`),
  }));

  // Config form state
  const [mode, setMode] = useState(initial.mode);
  const [position, setPosition] = useState(initial.position);
  const [chatEnabled, setChatEnabled] = useState(initial.chatEnabled);
  const [voiceEnabled, setVoiceEnabled] = useState(initial.voiceEnabled);
  const [welcomeMessage, setWelcomeMessage] = useState(initial.welcomeMessage);
  const [placeholderText, setPlaceholderText] = useState(initial.placeholderText);
  const [voicePipeline, setVoicePipeline] = useState(initial.voicePipeline);
  const [saving, setSaving] = useState(false);

  // Active toggle
  const [isActive, setIsActive] = useState(channel.isActive);
  const [togglingActive, setTogglingActive] = useState(false);

  // Preview link state
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareExpiry, setShareExpiry] = useState<string | null>(null);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [previewCopied, setPreviewCopied] = useState(false);

  // Voice preview state
  const [livekitAvailable, setLivekitAvailable] = useState<boolean | null>(null);
  const [voiceShareUrl, setVoiceShareUrl] = useState<string | null>(null);
  const [voiceShareExpiry, setVoiceShareExpiry] = useState<string | null>(null);
  const [generatingVoiceLink, setGeneratingVoiceLink] = useState(false);
  const [voicePreviewCopied, setVoicePreviewCopied] = useState(false);

  // Embed code state
  const [embedCode, setEmbedCode] = useState('');
  const [embedError, setEmbedError] = useState<string | null>(null);
  const [embedLoading, setEmbedLoading] = useState(false);

  // Voice credential check state
  const [voiceCredsLoading, setVoiceCredsLoading] = useState(false);
  const [hasSTTCreds, setHasSTTCreds] = useState<boolean | null>(null);
  const [hasTTSCreds, setHasTTSCreds] = useState<boolean | null>(null);

  // Realtime model availability
  const [hasRealtimeModel, setHasRealtimeModel] = useState<boolean | null>(null);
  const [realtimeModelLoading, setRealtimeModelLoading] = useState(false);
  const tenantId = useAuthStore((s) => s.tenantId);
  const navigate = useNavigationStore((s) => s.navigate);

  // Delete state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Deployment binding state
  const [bindingEnvironment, setBindingEnvironment] = useState<string | null>(
    channel.environment ?? null,
  );
  const [bindingFollowEnv, setBindingFollowEnv] = useState(
    channel.followEnvironment ?? Boolean(channel.environment),
  );
  const [bindingDeploymentId, setBindingDeploymentId] = useState<string | null>(
    channel.deploymentId,
  );
  const [envDeployments, setEnvDeployments] = useState<Deployment[]>([]);
  const [savingBinding, setSavingBinding] = useState(false);

  // Load deployments for the binding section
  useEffect(() => {
    fetchDeployments(projectId, { status: 'active' })
      .then((data) => setEnvDeployments(data.deployments))
      .catch(() => setEnvDeployments([]));
  }, [projectId]);

  // Sync binding state when channel changes
  useEffect(() => {
    setBindingEnvironment(channel.environment ?? null);
    setBindingFollowEnv(channel.followEnvironment ?? Boolean(channel.environment));
    setBindingDeploymentId(channel.deploymentId);
  }, [
    channel.deploymentId,
    channel.environment,
    channel.followEnvironment,
    channel.id,
    channel.updatedAt,
  ]);

  const bindingDirty =
    bindingEnvironment !== (channel.environment ?? null) ||
    bindingFollowEnv !== (channel.followEnvironment ?? Boolean(channel.environment)) ||
    bindingDeploymentId !== channel.deploymentId;

  const handleSaveBinding = async () => {
    setSavingBinding(true);
    try {
      await updateChannel(
        projectId,
        channel.id,
        buildSdkChannelBindingUpdate({
          environment: bindingEnvironment ?? '',
          followEnvironment: bindingFollowEnv,
          pinnedDeploymentId: bindingDeploymentId ?? '',
        }),
      );
      toast.success(t('binding_saved'));
      await onUpdated();
    } catch (err) {
      toast.error(sanitizeError(err, t('binding_save_failed')));
    } finally {
      setSavingBinding(false);
    }
  };

  // Re-init form when channel changes
  useEffect(() => {
    const c = parseConfig((channel.config ?? {}) as Record<string, unknown>);
    setMode(c.mode);
    setPosition(c.position);
    setChatEnabled(c.chatEnabled);
    setVoiceEnabled(c.voiceEnabled);
    setWelcomeMessage(c.welcomeMessage);
    setPlaceholderText(c.placeholderText);
    setVoicePipeline(c.voicePipeline);
    setIsActive(channel.isActive);
  }, [channel.id, channel.updatedAt]);

  // Whether the saved channel config has voice enabled
  const savedVoiceEnabled =
    initial.voiceEnabled || initial.mode === 'voice' || initial.mode === 'unified';
  const isVoiceChannel = channel.channelType.startsWith('voice_');
  const isVoiceLiveKit = channel.channelType === 'voice_livekit';
  const isVoiceTwilio = channel.channelType === 'voice_twilio';

  // Check LiveKit capabilities (web + voice-enabled channels, or voice_livekit channels)
  const isVoiceCapable = isVoiceLiveKit || (channel.channelType === 'web' && savedVoiceEnabled);
  useEffect(() => {
    if (!isVoiceCapable) return;
    apiFetch('/api/livekit/capabilities')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setLivekitAvailable(data?.configured ?? false))
      .catch(() => setLivekitAvailable(false));
  }, [isVoiceCapable]);

  // Check voice service credentials for voice-capable channels
  useEffect(() => {
    if (!isVoiceCapable || !tenantId) return;
    setVoiceCredsLoading(true);
    const sttServiceType = initial.asrVendor || 'deepgram';
    const ttsServiceType = initial.ttsVendor || 'elevenlabs';
    const sttServiceInstanceId = initial.asrServiceInstanceId as string | undefined;
    const ttsServiceInstanceId = initial.ttsServiceInstanceId as string | undefined;

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
        .catch(() => setHasSTTCreds(false)),
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
        .catch(() => setHasTTSCreds(false)),
    ]).finally(() => setVoiceCredsLoading(false));
  }, [
    initial.asrServiceInstanceId,
    initial.asrVendor,
    initial.ttsServiceInstanceId,
    initial.ttsVendor,
    isVoiceCapable,
    tenantId,
  ]);

  // Check for realtime-voice-capable tenant models
  useEffect(() => {
    if (!isVoiceCapable || !tenantId) return;
    setRealtimeModelLoading(true);
    apiFetch('/api/tenant-models?isActive=true')
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
      .catch(() => setHasRealtimeModel(false))
      .finally(() => setRealtimeModelLoading(false));
  }, [isVoiceCapable, tenantId]);

  // Fetch embed code on mount (web channels only)
  useEffect(() => {
    if (channel.channelType !== 'web') return;
    setEmbedLoading(true);
    setEmbedError(null);
    fetchSdkEmbedCode(projectId, channel.id)
      .then((snippet) => setEmbedCode(snippet))
      .catch((error) => {
        setEmbedCode('');
        setEmbedError(sanitizeError(error, SDK_EMBED_FETCH_ERROR));
      })
      .finally(() => setEmbedLoading(false));
  }, [projectId, channel.channelType, channel.id]);

  // Voice pipeline mode awareness
  const effectiveVoicePipeline = isVoiceChannel
    ? voicePipeline
    : voiceEnabled || mode === 'voice' || mode === 'unified'
      ? voicePipeline
      : null;
  const isRealtimeMode = effectiveVoicePipeline === 'realtime';

  // Saved (persisted) pipeline mode — preview uses saved config, not form state
  const savedIsRealtimeMode = initial.voicePipeline === 'realtime';

  // Voice credentials readiness (only relevant for pipeline/auto modes)
  const voiceCredsMissing =
    isVoiceCapable && !isRealtimeMode && (hasSTTCreds === false || hasTTSCreds === false);

  // Realtime model readiness (only relevant for realtime mode)
  const realtimeModelMissing = isVoiceCapable && isRealtimeMode && hasRealtimeModel === false;

  // Dirty check
  const isDirty = isVoiceChannel
    ? welcomeMessage !== initial.welcomeMessage || voicePipeline !== initial.voicePipeline
    : mode !== initial.mode ||
      position !== initial.position ||
      chatEnabled !== initial.chatEnabled ||
      voiceEnabled !== initial.voiceEnabled ||
      welcomeMessage !== initial.welcomeMessage ||
      placeholderText !== initial.placeholderText ||
      voicePipeline !== initial.voicePipeline;

  // --- Handlers ---

  const handleToggleActive = async (checked: boolean) => {
    setIsActive(checked);
    setTogglingActive(true);
    try {
      await updateChannel(projectId, channel.id, { isActive: checked });
      toast.success(checked ? t('channel_activated') : t('channel_deactivated'));
      await onUpdated();
    } catch (err) {
      setIsActive(!checked);
      toast.error(sanitizeError(err, t('channel_update_failed')));
    } finally {
      setTogglingActive(false);
    }
  };

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const updatedConfig: Record<string, unknown> = isVoiceChannel
        ? {
            mode: 'voice',
            voiceEnabled: true,
            chatEnabled: false,
            welcomeMessage: welcomeMessage || null,
            voicePipeline,
          }
        : {
            mode,
            position,
            chatEnabled,
            voiceEnabled,
            welcomeMessage: welcomeMessage || null,
            placeholderText: placeholderText || null,
            voicePipeline,
          };
      await updateChannel(projectId, channel.id, { config: updatedConfig });
      toast.success(t('config_saved'));
      await onUpdated();
    } catch (err) {
      toast.error(sanitizeError(err, t('config_save_failed')));
    } finally {
      setSaving(false);
    }
  };

  const generateSecureLink = async () => {
    setGeneratingLink(true);
    try {
      const response = await apiFetch('/api/sdk/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          channelId: channel.id,
          expiresIn: 7 * 24 * 60 * 60 * 1000,
        }),
      });
      if (response.ok) {
        const data = await response.json();
        setShareUrl(data.shareUrl);
        setShareExpiry(data.expiresAt);
      } else {
        toast.error(t('preview_error'));
      }
    } catch {
      toast.error(t('preview_error'));
    } finally {
      setGeneratingLink(false);
    }
  };

  const generateVoiceShareLink = async () => {
    setGeneratingVoiceLink(true);
    try {
      const response = await apiFetch('/api/sdk/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          channelId: channel.id,
          expiresIn: 7 * 24 * 60 * 60 * 1000,
        }),
      });
      if (response.ok) {
        const data = await response.json();
        const url = new URL(data.shareUrl);
        // Realtime voice uses SDK WebSocket path (/preview), pipeline uses LiveKit (/preview-livekit)
        url.pathname = savedIsRealtimeMode ? '/preview' : '/preview-livekit';
        // Signal the preview page to open in voice mode
        url.searchParams.set('mode', 'voice');
        setVoiceShareUrl(url.toString());
        setVoiceShareExpiry(data.expiresAt);
      } else {
        toast.error(t('voice_preview_error'));
      }
    } catch {
      toast.error(t('voice_preview_error'));
    } finally {
      setGeneratingVoiceLink(false);
    }
  };

  const copyToClipboard = async (text: string, onCopied: (v: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      onCopied(true);
      setTimeout(() => onCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteChannel(projectId, channel.id);
      toast.success(t('delete_success'));
      onDeleted();
    } catch (err) {
      toast.error(sanitizeError(err, t('delete_failed')));
    } finally {
      setIsDeleting(false);
    }
  };

  const isWebChannel = channel.channelType === 'web';

  return (
    <div className="space-y-6">
      {/* ================================================================== */}
      {/* Section 1 — Header                                                 */}
      {/* ================================================================== */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onBack}
            className="p-1.5 text-muted hover:text-foreground rounded-lg hover:bg-background-muted transition-default"
            aria-label={t('back')}
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-muted shrink-0">
            {channelTypeIcons[channel.channelType] || channelTypeIcons.api}
          </span>
          <span className="text-base font-semibold text-foreground truncate">{channel.name}</span>
          <Badge variant="accent">
            {tType(channel.channelType, { defaultValue: channel.channelType })}
          </Badge>
          <Badge variant={isActive ? 'success' : 'default'} dot>
            {isActive ? t('active') : t('inactive')}
          </Badge>
        </div>
        <Toggle
          checked={isActive}
          onChange={handleToggleActive}
          disabled={togglingActive}
          label={t('active_label')}
        />
      </div>

      {/* Metadata row */}
      <div className="flex items-center gap-4 text-xs text-muted -mt-3">
        {deploymentLabel && <span>{t('deployment_label', { label: deploymentLabel })}</span>}
        {apiKeyPrefix && <span>{t('key_label', { prefix: apiKeyPrefix })}</span>}
        <span>
          {t('created_label', { date: new Date(channel.createdAt).toLocaleDateString() })}
        </span>
      </div>

      {/* ================================================================== */}
      {/* Deployment Binding                                                  */}
      {/* ================================================================== */}
      <div className="p-5 rounded-lg border border-default bg-background-elevated">
        <h3 className="text-sm font-semibold text-foreground mb-4">{t('binding_title')}</h3>

        <div className="space-y-4">
          {/* Deployment re-link */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('binding_pinned_label')}
            </label>
            <select
              value={bindingDeploymentId ?? ''}
              onChange={(e) => {
                const nextDeploymentId = e.target.value || null;
                setBindingDeploymentId(nextDeploymentId);
                if (nextDeploymentId) {
                  setBindingEnvironment(null);
                  setBindingFollowEnv(false);
                }
              }}
              className="w-full px-3 py-2 rounded-lg border border-default bg-background text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-border-focus"
            >
              <option value="">{AUTO_RESOLVE_DEPLOYMENT_LABEL}</option>
              {envDeployments.map((d) => (
                <option key={d.id} value={d.id}>
                  #{d.id.substring(0, 8)} ({d.environment}){d.label ? ` - ${d.label}` : ''}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted mt-1">
              Select a specific deployment to pin this channel to, or use environment-based
              auto-resolution below.
            </p>
          </div>

          {/* Environment */}
          {!bindingDeploymentId && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                {t('binding_env_label')}
              </label>
              <select
                value={bindingEnvironment ?? ''}
                onChange={(e) => {
                  const nextEnvironment = e.target.value || null;
                  setBindingEnvironment(nextEnvironment);
                  if (nextEnvironment) {
                    setBindingDeploymentId(null);
                    setBindingFollowEnv(true);
                  } else {
                    setBindingFollowEnv(false);
                  }
                }}
                className="w-full px-3 py-2 rounded-lg border border-default bg-background text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-border-focus"
              >
                {ENVIRONMENT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted mt-1">{t('binding_env_hint')}</p>
            </div>
          )}

          {/* Follow toggle */}
          {!bindingDeploymentId && bindingEnvironment && (
            <div className="flex items-center justify-between p-3 bg-background-subtle rounded-lg">
              <div>
                <span className="text-sm text-foreground">{t('binding_follow_title')}</span>
                <p className="text-xs text-muted mt-0.5">{t('binding_follow_description')}</p>
              </div>
              <Toggle checked={bindingFollowEnv} onChange={setBindingFollowEnv} />
            </div>
          )}

          {/* Save */}
          <div className="flex items-center justify-between">
            {bindingDirty && <span className="text-xs text-warning">{t('unsaved_changes')}</span>}
            {!bindingDirty && <span />}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSaveBinding}
              loading={savingBinding}
              disabled={!bindingDirty}
            >
              {t('binding_save')}
            </Button>
          </div>
        </div>
      </div>

      {/* Voice credential warning — only for pipeline/auto modes (not realtime) */}
      {isVoiceCapable &&
        !isRealtimeMode &&
        !voiceCredsLoading &&
        (hasSTTCreds === false || hasTTSCreds === false) && (
          <div className="p-4 rounded-lg border border-warning/30 bg-warning/5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-medium text-foreground">
                  {t('voice_creds_missing_title')}
                </h4>
                <p className="text-xs text-muted mt-1">
                  {hasSTTCreds === false && hasTTSCreds === false
                    ? t('voice_creds_both_missing')
                    : hasSTTCreds === false
                      ? t('voice_creds_stt_missing')
                      : t('voice_creds_tts_missing')}{' '}
                  {t('voice_creds_impact')}
                </p>
                <button
                  onClick={() => navigate('/admin/voice')}
                  className="mt-2 text-xs font-medium text-info hover:text-info/80 transition-default"
                >
                  {t('voice_creds_configure')} &rarr;
                </button>
              </div>
            </div>
          </div>
        )}

      {/* Realtime voice model warning — only for realtime mode */}
      {isVoiceCapable && isRealtimeMode && !realtimeModelLoading && hasRealtimeModel === false && (
        <div className="p-4 rounded-lg border border-warning/30 bg-warning/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
            <div>
              <h4 className="text-sm font-medium text-foreground">
                {t('realtime_model_missing_title')}
              </h4>
              <p className="text-xs text-muted mt-1">{t('realtime_model_missing_description')}</p>
              <button
                onClick={() => navigate('/admin/models')}
                className="mt-2 text-xs font-medium text-info hover:text-info/80 transition-default"
              >
                {t('realtime_model_configure')} &rarr;
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================== */}
      {/* Section 2 — Widget Configuration                                   */}
      {/* ================================================================== */}
      <div className="p-5 rounded-lg border border-default bg-background-elevated">
        <h3 className="text-sm font-semibold text-foreground mb-4">
          {isVoiceChannel ? t('voice_config_title') : t('widget_config_title')}
        </h3>

        {/* Mode picker — hidden for voice channels (always voice) */}
        {!isVoiceChannel && (
          <div className="mb-5">
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('widget_mode_label')}
            </label>
            <div className="grid grid-cols-3 gap-3">
              {modeOptions.map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setMode(opt.id)}
                  className={`flex flex-col items-center gap-2 p-3 rounded-lg border transition-default text-sm ${
                    mode === opt.id
                      ? 'border-accent bg-accent-subtle text-accent'
                      : 'border-default bg-background-subtle text-muted hover:border-muted'
                  }`}
                >
                  <opt.icon className="w-4 h-4" />
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Position picker — hidden for voice channels (no widget) */}
        {!isVoiceChannel && (
          <div className="mb-5">
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('position_label')}
            </label>
            <div className="grid grid-cols-2 gap-2">
              {positionOptions.map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setPosition(opt.id)}
                  className={`px-3 py-2 rounded-lg border text-sm transition-default ${
                    position === opt.id
                      ? 'border-accent bg-accent-subtle text-accent'
                      : 'border-default bg-background-subtle text-muted hover:border-muted'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Feature toggles — hidden for voice channels (always voice-only) */}
        {!isVoiceChannel && (
          <div className="mb-5">
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('features_label')}
            </label>
            <div className="space-y-2">
              <div className="flex items-center justify-between p-3 bg-background-subtle rounded-lg">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-muted" />
                  <span className="text-sm text-foreground">{t('feature_chat')}</span>
                </div>
                <Toggle checked={chatEnabled} onChange={setChatEnabled} />
              </div>
              <div className="flex items-center justify-between p-3 bg-background-subtle rounded-lg">
                <div className="flex items-center gap-2">
                  <Mic className="w-4 h-4 text-muted" />
                  <span className="text-sm text-foreground">{t('feature_voice')}</span>
                </div>
                <Toggle checked={voiceEnabled} onChange={setVoiceEnabled} />
              </div>
            </div>
          </div>
        )}

        {/* Voice Pipeline picker — shown for voice channels and when voice is enabled */}
        {(isVoiceChannel || voiceEnabled || mode === 'voice' || mode === 'unified') && (
          <div className="mb-5">
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('voice_pipeline_label')}
            </label>
            <div className="grid grid-cols-3 gap-3">
              {voicePipelineOptions.map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setVoicePipeline(opt.id)}
                  className={`flex flex-col items-start gap-1 p-3 rounded-lg border transition-default text-sm ${
                    voicePipeline === opt.id
                      ? 'border-accent bg-accent-subtle text-accent'
                      : 'border-default bg-background-subtle text-muted hover:border-muted'
                  }`}
                >
                  <span className="font-medium">{opt.label}</span>
                  <span className="text-xs opacity-70">{opt.description}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="space-y-4 mb-5">
          <Input
            label={t('welcome_message_label')}
            value={welcomeMessage}
            onChange={(e) => setWelcomeMessage(e.target.value)}
            placeholder={
              isVoiceChannel
                ? t('welcome_message_voice_placeholder')
                : t('welcome_message_placeholder')
            }
          />
          {/* Placeholder text — hidden for voice channels (no chat input) */}
          {!isVoiceChannel && (
            <Input
              label={t('input_placeholder_label')}
              value={placeholderText}
              onChange={(e) => setPlaceholderText(e.target.value)}
              placeholder={t('input_placeholder_value')}
            />
          )}
        </div>

        {/* Save */}
        <div className="flex items-center justify-between">
          {isDirty && <span className="text-xs text-warning">{t('unsaved_changes')}</span>}
          {!isDirty && <span />}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSaveConfig}
            loading={saving}
            disabled={!isDirty}
          >
            {t('save_configuration')}
          </Button>
        </div>
      </div>

      {/* ================================================================== */}
      {/* Section 3 — Preview & Testing                                      */}
      {/* ================================================================== */}
      {/* Web channels: chat preview + voice preview (if voice enabled) */}
      {isWebChannel && (
        <div className="p-5 rounded-lg border border-default bg-background-elevated">
          <h3 className="text-sm font-semibold text-foreground mb-4">
            {t('preview_testing_title')}
          </h3>

          {/* Secure Preview Link */}
          <div className="p-4 bg-purple-subtle border border-purple rounded-lg mb-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Lock className="w-4 h-4 text-purple" />
                <h4 className="text-sm font-medium text-purple">{t('secure_preview_title')}</h4>
              </div>
              {!shareUrl ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={generateSecureLink}
                  loading={generatingLink}
                  icon={generatingLink ? undefined : <Plus className="w-3 h-3" />}
                  className="bg-purple hover:bg-purple"
                >
                  {t('generate_link')}
                </Button>
              ) : (
                <button
                  onClick={() => copyToClipboard(shareUrl, setPreviewCopied)}
                  className="flex items-center gap-2 px-3 py-1.5 bg-purple-subtle text-purple text-xs font-medium rounded-lg hover:bg-purple-subtle transition-default"
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
                  Expires on {new Date(shareExpiry!).toLocaleDateString()}.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-background border border-default rounded-lg text-sm text-purple font-mono truncate">
                    {shareUrl}
                  </code>
                  <a
                    href={shareUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2 bg-background-subtle text-muted rounded-lg hover:bg-background-muted transition-default"
                    title={t('generate_link')}
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

          {/* Voice Preview — only when voice is enabled in saved config */}
          {/* Pipeline mode needs LiveKit; Realtime mode uses SDK WebSocket directly */}
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
                    {savedIsRealtimeMode
                      ? t('voice_preview_realtime')
                      : t('voice_preview_pipeline')}
                  </h4>
                </div>
                {!voiceShareUrl ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={generateVoiceShareLink}
                    loading={generatingVoiceLink}
                    disabled={savedIsRealtimeMode ? hasRealtimeModel === false : voiceCredsMissing}
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
                    Generate Link
                  </Button>
                ) : (
                  <button
                    onClick={() => copyToClipboard(voiceShareUrl, setVoicePreviewCopied)}
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
                    Expires on {new Date(voiceShareExpiry!).toLocaleDateString()}.
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
          )}
        </div>
      )}

      {/* Voice (LiveKit) channel — dedicated voice preview */}
      {isVoiceLiveKit && (
        <div className="p-5 rounded-lg border border-default bg-background-elevated">
          <h3 className="text-sm font-semibold text-foreground mb-4">{t('voice_preview_title')}</h3>

          {!savedIsRealtimeMode && livekitAvailable === null && (
            <div className="p-4 flex items-center gap-2 text-muted">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-xs">{t('checking_livekit')}</span>
            </div>
          )}
          {!savedIsRealtimeMode && livekitAvailable === false && (
            <div className="p-4 bg-background-muted/50 border border-default/50 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <Mic className="w-4 h-4 text-muted" />
                <h4 className="text-sm font-medium text-muted">
                  {t('livekit_not_configured_title')}
                </h4>
              </div>
              <p className="text-xs text-muted">{t('livekit_not_configured')}</p>
            </div>
          )}
          {(savedIsRealtimeMode || livekitAvailable === true) && (
            <div className="p-4 bg-success-subtle border border-success rounded-lg">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Mic className="w-4 h-4 text-success" />
                  <h4 className="text-sm font-medium text-success">
                    {savedIsRealtimeMode
                      ? t('voice_preview_realtime')
                      : t('voice_preview_pipeline')}
                  </h4>
                </div>
                {!voiceShareUrl ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={generateVoiceShareLink}
                    loading={generatingVoiceLink}
                    disabled={savedIsRealtimeMode ? hasRealtimeModel === false : voiceCredsMissing}
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
                    Generate Link
                  </Button>
                ) : (
                  <button
                    onClick={() => copyToClipboard(voiceShareUrl, setVoicePreviewCopied)}
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
                    Expires on {new Date(voiceShareExpiry!).toLocaleDateString()}.
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
          )}
        </div>
      )}

      {/* Voice (Twilio) channel — info note, no browser preview */}
      {isVoiceTwilio && (
        <div className="p-5 rounded-lg border border-default bg-background-elevated">
          <h3 className="text-sm font-semibold text-foreground mb-4">{t('voice_access_title')}</h3>
          <div className="flex items-start gap-3 p-4 bg-info-subtle border border-info rounded-lg">
            <Info className="w-5 h-5 text-info shrink-0 mt-0.5" />
            <div>
              <h4 className="text-sm font-medium text-info mb-1">{t('twilio_voice_title')}</h4>
              <p className="text-xs text-muted">{t('twilio_voice_description')}</p>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================== */}
      {/* Section 4 — Embed Code (web channels only)                         */}
      {/* ================================================================== */}
      {isWebChannel && (
        <div className="p-5 rounded-lg border border-default bg-background-elevated">
          <h3 className="text-sm font-semibold text-foreground mb-4">{t('embed_code_title')}</h3>

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
                <h4 className="text-sm font-medium text-foreground mb-1">
                  {t('quick_start_title')}
                </h4>
                <ol className="space-y-0.5 text-xs text-muted">
                  <li>{t('quick_start_step1')}</li>
                  <li>{t('quick_start_step2')}</li>
                  <li>
                    {t('quick_start_step3_prefix')}{' '}
                    <code className="text-muted">&lt;/body&gt;</code>{' '}
                    {t('quick_start_step3_suffix')}
                  </li>
                  <li>{t('quick_start_step4')}</li>
                </ol>
              </div>
            </>
          )}
        </div>
      )}

      {/* ================================================================== */}
      {/* Section 5 — Danger Zone                                            */}
      {/* ================================================================== */}
      <div className="p-5 rounded-lg border border-error/30 bg-background-elevated">
        <h3 className="text-sm font-semibold text-error mb-2">{t('danger_zone_title')}</h3>
        <p className="text-xs text-muted mb-4">{t('danger_zone_description')}</p>
        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 className="w-3.5 h-3.5" />}
          onClick={() => setShowDeleteConfirm(true)}
        >
          {t('delete_channel')}
        </Button>
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title={t('delete_dialog_title')}
        description={t('delete_dialog_description', { name: channel.name })}
        confirmLabel={t('delete_channel')}
        variant="danger"
        loading={isDeleting}
      />
    </div>
  );
}
