import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { findActiveSdkChannelById, findActiveSdkChannelsByProject } from '@/repos/sdk-repo';
import { resolveSdkChannelDisplayConfig } from '@/lib/sdk-channel-display-config';

const log = createLogger('sdk-bootstrap-channel');

export interface ResolvedSdkBootstrapChannel {
  id: string;
  name?: string;
  publicApiKeyId: string;
  tenantId: string;
  projectId: string;
  config: Record<string, unknown>;
  showActivityUpdates: boolean;
}

type SdkBootstrapSurface = 'preview' | 'share' | 'embed';

interface ResolveSdkBootstrapChannelOptions {
  tenantId: string;
  projectId: string;
  channelId?: string;
  fallbackChannelId?: string;
  surface: SdkBootstrapSurface;
}

type ResolveSdkBootstrapChannelResult =
  | { success: true; channel: ResolvedSdkBootstrapChannel }
  | { success: false; response: NextResponse };

function surfaceLabel(surface: SdkBootstrapSurface): string {
  switch (surface) {
    case 'preview':
      return 'Preview';
    case 'share':
      return 'Share';
    case 'embed':
      return 'Embed';
  }
}

export async function resolveSdkBootstrapChannel(
  options: ResolveSdkBootstrapChannelOptions,
): Promise<ResolveSdkBootstrapChannelResult> {
  const { tenantId, projectId, channelId, fallbackChannelId, surface } = options;

  if (channelId) {
    const channel = await findActiveSdkChannelById(channelId, projectId, tenantId);
    if (!channel) {
      return {
        success: false,
        response: NextResponse.json({ error: 'Channel not found' }, { status: 404 }),
      };
    }

    return {
      success: true,
      channel: {
        id: channel.id,
        name: typeof channel.name === 'string' ? channel.name : undefined,
        publicApiKeyId: String(channel.publicApiKeyId),
        tenantId: String(channel.tenantId),
        projectId: String(channel.projectId),
        config: typeof channel.config === 'object' && channel.config !== null ? channel.config : {},
        showActivityUpdates: resolveSdkChannelDisplayConfig(channel.config).showActivityUpdates,
      },
    };
  }

  if (fallbackChannelId) {
    const fallbackChannel = await findActiveSdkChannelById(fallbackChannelId, projectId, tenantId);
    if (fallbackChannel) {
      return {
        success: true,
        channel: {
          id: fallbackChannel.id,
          name: typeof fallbackChannel.name === 'string' ? fallbackChannel.name : undefined,
          publicApiKeyId: String(fallbackChannel.publicApiKeyId),
          tenantId: String(fallbackChannel.tenantId),
          projectId: String(fallbackChannel.projectId),
          config:
            typeof fallbackChannel.config === 'object' && fallbackChannel.config !== null
              ? fallbackChannel.config
              : {},
          showActivityUpdates: resolveSdkChannelDisplayConfig(fallbackChannel.config)
            .showActivityUpdates,
        },
      };
    }

    log.info('Ignoring stale widget-configured SDK bootstrap channel and falling back', {
      tenantId,
      projectId,
      surface,
      fallbackChannelId,
    });
  }

  const activeChannels = await findActiveSdkChannelsByProject(projectId, tenantId);
  if (activeChannels.length === 1) {
    const [channel] = activeChannels;
    return {
      success: true,
      channel: {
        id: channel.id,
        name: typeof channel.name === 'string' ? channel.name : undefined,
        publicApiKeyId: String(channel.publicApiKeyId),
        tenantId: String(channel.tenantId),
        projectId: String(channel.projectId),
        config: typeof channel.config === 'object' && channel.config !== null ? channel.config : {},
        showActivityUpdates: resolveSdkChannelDisplayConfig(channel.config).showActivityUpdates,
      },
    };
  }

  if (activeChannels.length === 0) {
    log.warn('SDK bootstrap requested without any active SDK channel', {
      tenantId,
      projectId,
      surface,
    });
    return {
      success: false,
      response: NextResponse.json(
        {
          error: `${surfaceLabel(surface)} requires an active SDK channel. Create one before issuing SDK bootstrap artifacts.`,
        },
        { status: 422 },
      ),
    };
  }

  log.warn('SDK bootstrap requested without explicit channel selection', {
    tenantId,
    projectId,
    surface,
    activeChannelCount: activeChannels.length,
  });
  return {
    success: false,
    response: NextResponse.json(
      { error: 'Multiple active SDK channels found. Specify channelId.' },
      { status: 409 },
    ),
  };
}
