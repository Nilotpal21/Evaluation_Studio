/**
 * Channel Manifest -- Single Source of Truth
 *
 * Defines every channel's capabilities, auth mode, ingress path, delivery mode,
 * response format, and credential requirements. All channel-specific decisions
 * (webhook routing, voice detection, credential validation, connection eligibility,
 * URL generation) derive from this manifest rather than scattered hardcoded lists.
 *
 * To add a new channel: add a row to CHANNEL_MANIFEST. All derived sets and
 * helpers update automatically.
 */

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/** How inbound messages arrive from the external platform */
export type IngressMode = 'webhook' | 'websocket' | 'api' | 'smtp' | 'sync_webhook' | 'none';

/** How outbound messages are delivered to the external platform */
export type DeliveryMode = 'async_queue' | 'sync_response' | 'websocket' | 'direct_send' | 'none';

/**
 * How filler messages behave for this channel:
 * - 'chat': standard chat delay gate (chatDelayMs), status_update WS events
 * - 'voice_pipeline': voice-specific delay (voiceDelayMs), longer cooldown, lower maxPerTurn
 * - 'none': skip filler entirely (realtime voice, sync VXML — cannot inject mid-flight)
 */
export type ChannelFillerMode = 'chat' | 'voice_pipeline' | 'none';

/** Authentication mode for inbound requests */
export type AuthMode = 'hmac' | 'jwt' | 'token' | 'api_key' | 'sdk_auth' | 'hmac_jwt' | 'none';

/** Native response format for the channel */
export type ResponseFormat =
  | 'text'
  | 'markdown'
  | 'blocks'
  | 'adaptive_card'
  | 'interactive'
  | 'template'
  | 'voice_plain'
  | 'ssml'
  | 'ag_ui_events';

/** Describes a single channel's full capability profile */
export interface ChannelManifestEntry {
  /** Human-readable channel name */
  readonly displayName: string;
  /** How inbound messages arrive */
  readonly ingress: IngressMode;
  /** How outbound messages are delivered */
  readonly delivery: DeliveryMode;
  /** Authentication mechanism for inbound requests */
  readonly authMode: AuthMode;
  /** Native response format */
  readonly responseFormat: ResponseFormat;
  /** Whether the channel supports rich output (buttons, cards, etc.) */
  readonly supportsRichOutput: boolean;
  /** Whether the channel supports threaded conversations */
  readonly supportsThreading: boolean;
  /** Whether the channel supports media attachments */
  readonly supportsMedia: boolean;
  /** Whether the channel supports streaming responses */
  readonly supportsStreaming: boolean;
  /** Whether this channel type can be created as a channel-connection */
  readonly isConnectionEligible: boolean;
  /** Credential fields required when creating a connection */
  readonly requiredCredentials: readonly string[];
  /** Webhook route pattern (null if not webhook-based) */
  readonly webhookPathPattern: string | null;
  /** Whether this is a voice channel */
  readonly isVoice: boolean;
  /** Whether the channel supports typing indicators (bot is typing) */
  readonly supportsTypingIndicator: boolean;
  /** How filler messages should behave for this channel */
  readonly fillerMode: ChannelFillerMode;
}

// =============================================================================
// CHANNEL MANIFEST DATA
// =============================================================================

/**
 * Canonical channel manifest. Every channel type recognized by the platform
 * must have an entry here. Add new channels by adding a row -- all derived
 * sets (connection-eligible types, webhook types, voice types) update
 * automatically.
 */
export const CHANNEL_MANIFEST: Record<string, ChannelManifestEntry> = {
  // -------------------------------------------------------------------------
  // Async / webhook channels with connection management
  // -------------------------------------------------------------------------
  http_async: {
    displayName: 'HTTP Async',
    ingress: 'api',
    delivery: 'async_queue',
    authMode: 'api_key',
    responseFormat: 'text',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
    supportsTypingIndicator: false,
    fillerMode: 'chat',
  },

  slack: {
    displayName: 'Slack',
    ingress: 'webhook',
    delivery: 'async_queue',
    authMode: 'hmac',
    responseFormat: 'blocks',
    supportsRichOutput: true,
    supportsThreading: true,
    supportsMedia: true,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: ['bot_token', 'signing_secret'],
    webhookPathPattern: '/api/v1/channels/slack/webhook/:identifier',
    isVoice: false,
    supportsTypingIndicator: false,
    fillerMode: 'chat',
  },

  line: {
    displayName: 'LINE',
    ingress: 'webhook',
    delivery: 'async_queue',
    authMode: 'hmac',
    responseFormat: 'text',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: true,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: ['channel_access_token', 'channel_secret'],
    webhookPathPattern: '/api/v1/channels/line/webhook',
    isVoice: false,
    supportsTypingIndicator: true,
    fillerMode: 'chat',
  },

  msteams: {
    displayName: 'Microsoft Teams',
    ingress: 'webhook',
    delivery: 'async_queue',
    authMode: 'jwt',
    responseFormat: 'adaptive_card',
    supportsRichOutput: true,
    supportsThreading: true,
    supportsMedia: true,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: ['app_id', 'client_secret', 'tenant_id'],
    webhookPathPattern: '/api/v1/channels/msteams/webhook/:identifier',
    isVoice: false,
    supportsTypingIndicator: true,
    fillerMode: 'chat',
  },

  whatsapp: {
    displayName: 'WhatsApp',
    ingress: 'webhook',
    delivery: 'async_queue',
    authMode: 'hmac',
    responseFormat: 'interactive',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: true,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: ['access_token', 'app_secret', 'verify_token'],
    webhookPathPattern: '/api/v1/channels/whatsapp/webhook',
    isVoice: false,
    supportsTypingIndicator: false,
    fillerMode: 'chat',
  },

  messenger: {
    displayName: 'Messenger',
    ingress: 'webhook',
    delivery: 'async_queue',
    authMode: 'hmac',
    responseFormat: 'template',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: true,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: ['page_access_token', 'app_secret', 'verify_token'],
    webhookPathPattern: '/api/v1/channels/messenger/webhook',
    isVoice: false,
    supportsTypingIndicator: true,
    fillerMode: 'chat',
  },

  instagram: {
    displayName: 'Instagram',
    ingress: 'webhook',
    delivery: 'async_queue',
    authMode: 'hmac',
    responseFormat: 'template',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: true,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: ['page_access_token', 'app_secret', 'verify_token'],
    webhookPathPattern: '/api/v1/channels/instagram/webhook',
    isVoice: false,
    supportsTypingIndicator: true,
    fillerMode: 'chat',
  },

  twilio_sms: {
    displayName: 'Twilio SMS',
    ingress: 'webhook',
    delivery: 'async_queue',
    authMode: 'hmac',
    responseFormat: 'text',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: true,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: ['account_sid', 'auth_token'],
    webhookPathPattern: '/api/v1/channels/twilio_sms/webhook/:identifier',
    isVoice: false,
    supportsTypingIndicator: false,
    fillerMode: 'chat',
  },

  // Optional credential: webhook_secret — enables HMAC-SHA256 webhook verification.
  // Without it, inbound webhooks are accepted without signature checks.
  zendesk: {
    displayName: 'Zendesk',
    ingress: 'webhook',
    delivery: 'direct_send',
    authMode: 'hmac',
    responseFormat: 'text',
    supportsRichOutput: true,
    supportsThreading: true,
    supportsMedia: true,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: ['app_id', 'key_id', 'key_secret'],
    webhookPathPattern: '/api/v1/channels/zendesk/webhook/:identifier',
    isVoice: false,
    supportsTypingIndicator: false,
    fillerMode: 'chat',
  },

  telegram: {
    displayName: 'Telegram',
    ingress: 'webhook',
    delivery: 'async_queue',
    authMode: 'token',
    responseFormat: 'text',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: true,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: ['bot_token'],
    webhookPathPattern: '/api/v1/channels/telegram/webhook/:identifier',
    isVoice: false,
    supportsTypingIndicator: true,
    fillerMode: 'chat',
  },

  genesys: {
    displayName: 'Genesys',
    ingress: 'sync_webhook',
    delivery: 'sync_response',
    authMode: 'token',
    responseFormat: 'text',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: ['client_secret'],
    webhookPathPattern: '/api/v1/channels/genesys/hooks/:streamId',
    isVoice: false,
    supportsTypingIndicator: false,
    fillerMode: 'chat',
  },

  ai4w: {
    displayName: 'AI4W',
    ingress: 'api',
    delivery: 'async_queue',
    authMode: 'hmac_jwt',
    responseFormat: 'markdown',
    supportsRichOutput: false,
    supportsThreading: true,
    supportsMedia: true,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
    supportsTypingIndicator: false,
    fillerMode: 'chat',
  },

  // Outbound transport is configurable: SMTP (default) or Microsoft Graph API.
  // Graph credentials (graph_client_secret) are required only when
  // config.outbound.transport === 'graph' — validated at runtime by resolve-transport.ts.
  email: {
    displayName: 'Email',
    ingress: 'smtp',
    delivery: 'async_queue',
    authMode: 'none',
    responseFormat: 'markdown',
    supportsRichOutput: false,
    supportsThreading: true,
    supportsMedia: true,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
    supportsTypingIndicator: false,
    fillerMode: 'chat',
  },

  // -------------------------------------------------------------------------
  // Voice channels
  // -------------------------------------------------------------------------
  voice_vxml: {
    displayName: 'VXML',
    ingress: 'sync_webhook',
    delivery: 'sync_response',
    authMode: 'token',
    responseFormat: 'voice_plain',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: '/api/v1/channels/vxml/hooks/:streamId',
    isVoice: true,
    supportsTypingIndicator: false,
    fillerMode: 'none',
  },

  korevg: {
    displayName: 'Kore Voice Gateway',
    ingress: 'websocket',
    delivery: 'websocket',
    authMode: 'token',
    responseFormat: 'voice_plain',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: true,
    supportsTypingIndicator: false,
    fillerMode: 'voice_pipeline',
  },

  audiocodes: {
    displayName: 'AudioCodes',
    ingress: 'webhook',
    delivery: 'websocket',
    authMode: 'token',
    responseFormat: 'voice_plain',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: ['inboundAuthToken'],
    webhookPathPattern: '/api/v1/channels/audiocodes/webhook/:identifier',
    isVoice: true,
    supportsTypingIndicator: false,
    fillerMode: 'voice_pipeline',
  },

  voice_pipeline: {
    displayName: 'Pipeline Voice',
    ingress: 'websocket',
    delivery: 'websocket',
    authMode: 'token',
    responseFormat: 'voice_plain',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: true,
    supportsTypingIndicator: false,
    fillerMode: 'voice_pipeline',
  },

  voice_realtime: {
    displayName: 'Realtime Voice (S2S)',
    ingress: 'websocket',
    delivery: 'websocket',
    authMode: 'token',
    responseFormat: 'voice_plain',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: true,
    supportsTypingIndicator: false,
    fillerMode: 'none',
  },

  voice: {
    displayName: 'Voice',
    ingress: 'websocket',
    delivery: 'websocket',
    authMode: 'token',
    responseFormat: 'voice_plain',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: true,
    isConnectionEligible: false,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: true,
    supportsTypingIndicator: false,
    fillerMode: 'voice_pipeline',
  },

  voice_twilio: {
    displayName: 'Voice (Twilio)',
    ingress: 'webhook',
    delivery: 'websocket',
    authMode: 'hmac',
    responseFormat: 'voice_plain',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: '/api/v1/voice/connect',
    isVoice: true,
    supportsTypingIndicator: false,
    fillerMode: 'voice_pipeline',
  },

  voice_livekit: {
    displayName: 'Voice (LiveKit)',
    ingress: 'websocket',
    delivery: 'websocket',
    authMode: 'token',
    responseFormat: 'voice_plain',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: true,
    isConnectionEligible: false,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: true,
    supportsTypingIndicator: false,
    fillerMode: 'voice_pipeline',
  },

  // -------------------------------------------------------------------------
  // Realtime / WebSocket channels
  // -------------------------------------------------------------------------
  ag_ui: {
    displayName: 'AG-UI',
    ingress: 'websocket',
    delivery: 'websocket',
    authMode: 'sdk_auth',
    responseFormat: 'ag_ui_events',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
    supportsTypingIndicator: true,
    fillerMode: 'chat',
  },

  a2a: {
    displayName: 'Agent-to-Agent',
    ingress: 'api',
    delivery: 'async_queue',
    authMode: 'api_key',
    responseFormat: 'text',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
    supportsTypingIndicator: false,
    fillerMode: 'chat',
  },

  sdk_websocket: {
    displayName: 'SDK WebSocket',
    ingress: 'websocket',
    delivery: 'websocket',
    authMode: 'sdk_auth',
    responseFormat: 'markdown',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: true,
    supportsStreaming: true,
    isConnectionEligible: false,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
    supportsTypingIndicator: true,
    fillerMode: 'chat',
  },

  web_debug: {
    displayName: 'Web Debug',
    ingress: 'websocket',
    delivery: 'websocket',
    authMode: 'none',
    responseFormat: 'markdown',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: true,
    isConnectionEligible: false,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
    supportsTypingIndicator: true,
    fillerMode: 'chat',
  },

  web_chat: {
    displayName: 'Web Chat',
    ingress: 'websocket',
    delivery: 'websocket',
    authMode: 'sdk_auth',
    responseFormat: 'markdown',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: true,
    supportsStreaming: true,
    isConnectionEligible: false,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
    supportsTypingIndicator: true,
    fillerMode: 'chat',
  },

  // -------------------------------------------------------------------------
  // API channels (sync request/response)
  // -------------------------------------------------------------------------
  api: {
    displayName: 'API',
    ingress: 'api',
    delivery: 'sync_response',
    authMode: 'api_key',
    responseFormat: 'text',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: false,
    isConnectionEligible: false,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
    supportsTypingIndicator: false,
    fillerMode: 'chat',
  },

  http: {
    displayName: 'HTTP',
    ingress: 'api',
    delivery: 'sync_response',
    authMode: 'api_key',
    responseFormat: 'text',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: false,
    isConnectionEligible: false,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
    supportsTypingIndicator: false,
    fillerMode: 'chat',
  },
};

// =============================================================================
// DERIVED HELPERS
// =============================================================================

/**
 * Look up the manifest entry for a channel type.
 * Returns undefined for unknown channel types.
 */
export function getChannelManifest(channelType: string): ChannelManifestEntry | undefined {
  return CHANNEL_MANIFEST[channelType];
}

/**
 * Get all channel types that receive inbound messages via webhook
 * (either standard webhook or sync_webhook).
 */
export function getWebhookChannelTypes(): string[] {
  return Object.entries(CHANNEL_MANIFEST)
    .filter(([, entry]) => entry.ingress === 'webhook' || entry.ingress === 'sync_webhook')
    .map(([type]) => type);
}

/**
 * Get all channel types that use WebSocket for real-time communication.
 */
export function getRealtimeChannelTypes(): string[] {
  return Object.entries(CHANNEL_MANIFEST)
    .filter(([, entry]) => entry.ingress === 'websocket')
    .map(([type]) => type);
}

/**
 * Get all channel types that can be created as a channel-connection
 * (i.e., configured per-project via the channel-connections API).
 */
export function getConnectionChannelTypes(): string[] {
  return Object.entries(CHANNEL_MANIFEST)
    .filter(([, entry]) => entry.isConnectionEligible)
    .map(([type]) => type);
}

/**
 * Get all voice channel types.
 */
export function getVoiceChannelTypes(): string[] {
  return Object.entries(CHANNEL_MANIFEST)
    .filter(([, entry]) => entry.isVoice)
    .map(([type]) => type);
}

/**
 * Get the required credential fields for a channel type.
 * Returns an empty array for unknown channel types.
 */
export function getRequiredCredentials(channelType: string): string[] {
  const entry = CHANNEL_MANIFEST[channelType];
  return entry ? [...entry.requiredCredentials] : [];
}

/**
 * Build a fully-qualified webhook URL for a channel.
 *
 * Returns null if the channel has no webhookPathPattern.
 * Replaces `:identifier` and `:streamId` placeholders with the encoded
 * identifier value. When no identifier is provided, strips unresolved
 * parameter segments from the path.
 */
export function buildWebhookUrl(
  channelType: string,
  baseUrl: string,
  identifier?: string,
  provider?: string,
): string | null {
  // If provider is specified and not the default, build a provider-specific path
  if (provider && provider !== 'meta_cloud') {
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    return `${normalizedBase}/api/v1/channels/${channelType}/${provider}/webhook`;
  }

  // Existing logic for default providers
  const entry = CHANNEL_MANIFEST[channelType];
  if (!entry || !entry.webhookPathPattern) {
    return null;
  }

  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

  let path = entry.webhookPathPattern;

  if (identifier) {
    const encoded = encodeURIComponent(identifier);
    path = path.replace(':identifier', encoded);
    path = path.replace(':streamId', encoded);
  } else {
    // Strip unresolved path parameter segments (e.g., "/:identifier" or "/:streamId")
    path = path.replace(/\/:[\w]+/g, '');
  }

  return `${normalizedBase}${path}`;
}

/** Check if a string is a valid channel type known to the manifest. */
export function isKnownChannelType(type: string): boolean {
  return type in CHANNEL_MANIFEST;
}

// =============================================================================
// BACKWARD-COMPATIBLE DERIVED SETS
//
// These pre-computed sets are used by channel-connections.ts and
// channel-webhooks.ts. They are derived from CHANNEL_MANIFEST and kept
// in sync automatically.
// =============================================================================

/** Channel types that can have user-managed connection records. */
export const CONNECTION_CAPABLE_TYPES: readonly string[] = getConnectionChannelTypes();

/** Channel types that receive inbound webhooks (POST). */
export const WEBHOOK_CAPABLE_TYPES: ReadonlySet<string> = new Set(getWebhookChannelTypes());

/** Channel types that use Meta webhook verification (GET challenge). */
export const META_WEBHOOK_TYPES: ReadonlySet<string> = new Set(
  Object.entries(CHANNEL_MANIFEST)
    .filter(
      ([, entry]) =>
        entry.authMode === 'hmac' &&
        entry.ingress === 'webhook' &&
        entry.requiredCredentials.includes('verify_token'),
    )
    .map(([type]) => type),
);

/** Voice channel types for voice-specific routing. */
export const VOICE_TYPES: ReadonlySet<string> = new Set(getVoiceChannelTypes());
