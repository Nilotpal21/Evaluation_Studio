/**
 * ChannelCard Component
 *
 * Displays a single SDK channel with type, config summary, deployment link, and actions.
 * Clickable to navigate to detail view.
 */

import { Eye, Code, Settings, Trash2, Globe, Smartphone, Phone, Server } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import type { SDKChannel } from '../../api/channels';

interface ChannelCardProps {
  channel: SDKChannel;
  deploymentLabel?: string;
  apiKeyPrefix?: string;
  onSelect?: () => void;
  onPreview?: () => void;
  onEmbedCode?: () => void;
  onConfigure?: () => void;
  onDelete?: () => void;
}

const channelTypeIcons: Record<string, React.ReactNode> = {
  web: <Globe className="w-4 h-4" />,
  mobile_ios: <Smartphone className="w-4 h-4" />,
  mobile_android: <Smartphone className="w-4 h-4" />,
  voice: <Phone className="w-4 h-4" />,
  voice_livekit: <Phone className="w-4 h-4" />,
  voice_twilio: <Phone className="w-4 h-4" />,
  api: <Server className="w-4 h-4" />,
};

function useConfigSummary() {
  const t = useTranslations('deployments.channel_card');
  return (config: Record<string, unknown>): string => {
    const mode = config.mode as string;
    const chatEnabled = config.chatEnabled !== false;
    const voiceEnabled = !!config.voiceEnabled;
    const voicePipeline = config.voicePipeline as string | undefined;
    const realtimeSuffix = voicePipeline === 'realtime' ? ' (Realtime)' : '';

    if (mode === 'unified' || (chatEnabled && voiceEnabled))
      return t('chat_voice') + realtimeSuffix;
    if (mode === 'voice' || (voiceEnabled && !chatEnabled)) return t('voice_only') + realtimeSuffix;
    return t('chat_only');
  };
}

function getPositionLabel(config: Record<string, unknown>): string | null {
  const position = config.position as string | undefined;
  if (!position) return null;
  return position.replace('-', ' ');
}

export function ChannelCard({
  channel,
  deploymentLabel,
  apiKeyPrefix,
  onSelect,
  onPreview,
  onEmbedCode,
  onConfigure,
  onDelete,
}: ChannelCardProps) {
  const t = useTranslations('deployments');
  const getConfigSummary = useConfigSummary();
  const config = (channel.config || {}) as Record<string, unknown>;
  const configSummary = getConfigSummary(config);
  const positionLabel = getPositionLabel(config);

  return (
    <div
      className={`p-4 rounded-lg bg-background-elevated border border-default transition-default ${
        onSelect ? 'cursor-pointer hover:border-muted' : ''
      }`}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {/* Title row */}
          <div className="flex items-center gap-2">
            <span className="text-muted shrink-0">
              {channelTypeIcons[channel.channelType] || channelTypeIcons.api}
            </span>
            <span className="text-sm font-medium text-foreground truncate">{channel.name}</span>
            <Badge variant={channel.isActive ? 'success' : 'default'}>
              {channel.isActive ? t('channel_card.active') : t('channel_card.inactive')}
            </Badge>
          </div>

          {/* Config summary */}
          <div className="flex items-center gap-2 mt-1 text-xs text-muted">
            <span>{configSummary}</span>
            {positionLabel && (
              <>
                <span className="text-muted/50">&middot;</span>
                <span className="capitalize">{positionLabel}</span>
              </>
            )}
            {channel.environment && (
              <>
                <span className="text-muted/50">&middot;</span>
                <Badge variant="accent">{channel.environment}</Badge>
              </>
            )}
            {channel.followEnvironment && channel.environment && (
              <Badge variant="default">{t('channel_card.auto_follow')}</Badge>
            )}
          </div>

          {/* Metadata */}
          <div className="flex items-center gap-3 mt-1 text-xs text-muted">
            {deploymentLabel && <span>{deploymentLabel}</span>}
            {apiKeyPrefix && <span>{apiKeyPrefix}...</span>}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          {onPreview &&
            (channel.channelType === 'web' || channel.channelType === 'voice_livekit') && (
              <Button
                variant="ghost"
                size="sm"
                icon={<Eye className="w-3.5 h-3.5" />}
                onClick={onPreview}
              >
                {t('channel_card.preview')}
              </Button>
            )}
          {onEmbedCode && channel.channelType === 'web' && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Code className="w-3.5 h-3.5" />}
              onClick={onEmbedCode}
            >
              {t('channel_card.embed')}
            </Button>
          )}
          {onConfigure && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Settings className="w-3.5 h-3.5" />}
              onClick={onConfigure}
            >
              {t('channel_card.configure')}
            </Button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="p-1.5 text-muted hover:text-error rounded transition-default"
              title={t('channel_card.delete_channel')}
              aria-label={t('channel_card.delete_channel')}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
