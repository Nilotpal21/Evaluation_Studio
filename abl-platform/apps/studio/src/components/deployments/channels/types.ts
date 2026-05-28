/**
 * Unified Channel type definitions.
 */

import type { SDKChannelAuth } from '../../../api/channels';
import type { ReactNode } from 'react';

export type ChannelTypeId =
  | 'slack'
  | 'line'
  | 'msteams'
  | 'email'
  | 'whatsapp'
  | 'messenger'
  | 'twilio_sms'
  | 'telegram'
  | 'zendesk'
  | 'instagram'
  | 'genesys'
  | 'sdk_web'
  | 'sdk_mobile'
  | 'sdk_api'
  | 'http_async'
  | 'voice_realtime'
  | 'voice_pipeline'
  | 'voice_vxml'
  | 'ag_ui'
  | 'audiocodes'
  | 'a2a'
  | 'ai4w';

export type ChannelCategory = 'messaging' | 'sdk' | 'webhook' | 'voice' | 'protocol';

export interface ChannelCapabilities {
  multiConnection: boolean;
  hasCredentials: boolean;
  hasWebhookUrl: boolean;
  supportsTest: boolean;
  supportsDeliveryLog: boolean;
  autoGenerateIdentifier: boolean;
  supportsPauseResume: boolean;
  supportsOAuth?: boolean;
  supportsWidgetConfiguration?: boolean;
}

export interface CredentialFieldDef {
  key: string;
  label: string;
  placeholder: string;
  type: 'text' | 'password';
  required: boolean;
  validation?: (value: string) => string | null;
}

export interface ProviderOption {
  id: string;
  name: string;
  credentialFields: CredentialFieldDef[];
  setupInstructions: ReactNode;
  webhookPath: string | null;
  externalIdentifierLabel?: string;
  externalIdentifierPlaceholder?: string;
}

export interface ChannelTypeDef {
  id: ChannelTypeId;
  name: string;
  description: string;
  icon: ReactNode;
  available: boolean;
  category: ChannelCategory;
  capabilities: ChannelCapabilities;
  credentialFields: CredentialFieldDef[];
  setupInstructions: ReactNode;
  /** Path-only webhook route (e.g. /api/v1/channels/slack/webhook). Full URL resolved at render time. */
  webhookPath: string | null;
  providerOptions?: ProviderOption[];
  externalIdentifierLabel: string;
  externalIdentifierPlaceholder: string;
}

export type InstanceSource = 'sdk_channel' | 'channel_connection' | 'webhook_subscription';
export type InstanceStatus = 'active' | 'inactive' | 'error' | 'paused';

export interface ChannelInstance {
  id: string;
  channelType: ChannelTypeId;
  displayName: string;
  status: InstanceStatus;
  environment: string | null;
  deploymentId?: string | null;
  followEnvironment?: boolean;
  externalIdentifier: string | null;
  hasCredentials: boolean;
  config: Record<string, unknown>;
  auth?: SDKChannelAuth;
  identityVerification?: {
    providerVerificationStrength: 'weak' | 'strong';
  };
  webhookUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  _source: InstanceSource;
  _sourceId: string;
}

export type ChannelNavLevel =
  | { level: 'catalog' }
  | { level: 'list'; channelType: ChannelTypeId }
  | { level: 'config'; channelType: ChannelTypeId; instanceId: string };

/** Shared props interface for all channel tab components. */
export interface ChannelTabProps {
  projectId: string;
  channelType: ChannelTypeId;
  channelDef: ChannelTypeDef;
  instance: ChannelInstance;
  onRefresh: () => void;
}
