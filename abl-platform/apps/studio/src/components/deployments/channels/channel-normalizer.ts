/**
 * Channel Instance Normalizer
 *
 * Maps the three backend API models into a unified ChannelInstance view model.
 * No backend API changes -- pure frontend normalization.
 *
 * Sources:
 *  - SDKChannel           (apps/studio/src/api/channels.ts)
 *  - ChannelConnectionSummary (apps/studio/src/api/channel-connections.ts)
 *  - WebhookSubscription  (apps/studio/src/api/http-async-channels.ts)
 */

import type { SDKChannel } from '../../../api/channels';
import type { ChannelConnectionSummary } from '../../../api/channel-connections';
import type { WebhookSubscription } from '../../../api/http-async-channels';
import type { ChannelTypeId, ChannelInstance, InstanceStatus } from './types';
import { CHANNEL_REGISTRY } from './channel-registry';

// ---------------------------------------------------------------------------
// SDK Channel normalization
// ---------------------------------------------------------------------------

/** Map SDK channelType string to our ChannelTypeId */
function mapSDKType(sdkType: SDKChannel['channelType']): ChannelTypeId {
  switch (sdkType) {
    case 'web':
      return 'sdk_web';
    case 'mobile_ios':
    case 'mobile_android':
      return 'sdk_mobile';
    case 'api':
      return 'sdk_api';
    case 'voice':
    case 'voice_twilio':
      return 'voice_pipeline';
    case 'voice_livekit':
      return 'voice_realtime';
    default:
      return 'sdk_web';
  }
}

/** Map channel_connection.channelType string to our ChannelTypeId */
function mapConnectionType(connType: string): ChannelTypeId {
  switch (connType) {
    case 'slack':
      return 'slack';
    case 'line':
      return 'line';
    case 'msteams':
      return 'msteams';
    case 'email':
      return 'email';
    case 'whatsapp':
      return 'whatsapp';
    case 'messenger':
      return 'messenger';
    case 'twilio_sms':
      return 'twilio_sms';
    case 'vxml':
    case 'voice_vxml':
      return 'voice_vxml';
    case 'jambonz':
      return 'voice_pipeline';
    case 'voice_realtime':
      return 'voice_realtime';
    case 'voice_pipeline':
      return 'voice_pipeline';
    case 'ag_ui':
      return 'ag_ui';
    case 'a2a':
      return 'a2a';
    case 'audiocodes':
      return 'audiocodes';
    case 'http_async':
      return 'http_async';
    case 'zendesk':
      return 'zendesk';
    case 'instagram':
      return 'instagram';
    case 'genesys':
      return 'genesys';
    case 'telegram':
      return 'telegram';
    case 'ai4w':
      return 'ai4w';
    default:
      return connType as ChannelTypeId;
  }
}

export function normalizeSDKChannel(ch: SDKChannel): ChannelInstance {
  return {
    id: `sdk_${ch.id}`,
    channelType: mapSDKType(ch.channelType),
    displayName: ch.name,
    status: ch.isActive ? 'active' : 'inactive',
    environment: ch.environment,
    deploymentId: ch.deploymentId,
    followEnvironment: ch.followEnvironment,
    externalIdentifier: null,
    hasCredentials: false,
    config: ch.config,
    auth: ch.auth,
    createdAt: ch.createdAt,
    updatedAt: ch.updatedAt,
    _source: 'sdk_channel',
    _sourceId: ch.id,
  };
}

// ---------------------------------------------------------------------------
// Channel Connection normalization
// ---------------------------------------------------------------------------

function mapConnectionStatus(status: string): InstanceStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'error':
      return 'error';
    default:
      return 'inactive';
  }
}

export function normalizeConnection(conn: ChannelConnectionSummary): ChannelInstance {
  const channelType = mapConnectionType(conn.channelType);
  const def = CHANNEL_REGISTRY[channelType];
  return {
    id: `conn_${conn.id}`,
    channelType,
    displayName: conn.displayName || def?.name || conn.channelType,
    status: mapConnectionStatus(conn.status),
    environment: conn.environment,
    deploymentId: conn.deploymentId,
    externalIdentifier: conn.externalIdentifier || null,
    hasCredentials: conn.hasCredentials,
    config: conn.config,
    identityVerification: conn.identityVerification,
    webhookUrl: conn.webhookUrl || null,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
    _source: 'channel_connection',
    _sourceId: conn.id,
  };
}

// ---------------------------------------------------------------------------
// Webhook Subscription normalization
// ---------------------------------------------------------------------------

function mapSubStatus(status: WebhookSubscription['status']): InstanceStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'paused':
      return 'paused';
    case 'deactivated':
      return 'inactive';
  }
}

export function normalizeSubscription(sub: WebhookSubscription): ChannelInstance {
  return {
    id: `sub_${sub.id}`,
    channelType: 'http_async',
    displayName: sub.description || sub.callbackUrl,
    status: mapSubStatus(sub.status),
    environment: null,
    externalIdentifier: sub.callbackUrl,
    hasCredentials: false,
    config: { events: sub.events, callbackUrl: sub.callbackUrl },
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
    _source: 'webhook_subscription',
    _sourceId: sub.id,
  };
}

// ---------------------------------------------------------------------------
// Aggregate normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize all three backend sources and group by ChannelTypeId.
 */
export function normalizeAllInstances(
  sdkChannels: SDKChannel[],
  connections: ChannelConnectionSummary[],
  subscriptions: WebhookSubscription[],
): Map<ChannelTypeId, ChannelInstance[]> {
  const result = new Map<ChannelTypeId, ChannelInstance[]>();

  const addInstance = (instance: ChannelInstance) => {
    const existing = result.get(instance.channelType) || [];
    existing.push(instance);
    result.set(instance.channelType, existing);
  };

  for (const ch of sdkChannels) addInstance(normalizeSDKChannel(ch));
  for (const conn of connections) addInstance(normalizeConnection(conn));
  for (const sub of subscriptions) addInstance(normalizeSubscription(sub));

  return result;
}
