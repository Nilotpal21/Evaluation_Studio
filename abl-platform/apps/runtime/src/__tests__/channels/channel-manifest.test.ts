/**
 * Channel Manifest Tests
 *
 * Validates the channel manifest data and derived helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  CHANNEL_MANIFEST,
  getChannelManifest,
  getWebhookChannelTypes,
  getRealtimeChannelTypes,
  getConnectionChannelTypes,
  getVoiceChannelTypes,
  getRequiredCredentials,
  buildWebhookUrl,
  isKnownChannelType,
  CONNECTION_CAPABLE_TYPES,
  WEBHOOK_CAPABLE_TYPES,
  META_WEBHOOK_TYPES,
  VOICE_TYPES,
} from '../../channels/manifest.js';

// =============================================================================
// MANIFEST COMPLETENESS
// =============================================================================

describe('CHANNEL_MANIFEST completeness', () => {
  const EXPECTED_CHANNELS = [
    'http_async',
    'slack',
    'line',
    'msteams',
    'whatsapp',
    'messenger',
    'instagram',
    'twilio_sms',
    'zendesk',
    'telegram',
    'genesys',
    'email',
    'voice_vxml',
    'korevg',
    'audiocodes',
    'ag_ui',
    'ai4w',
    'a2a',
    'sdk_websocket',
    'web_debug',
    'web_chat',
    'api',
    'http',
    'voice',
    'voice_twilio',
    'voice_livekit',
    'voice_pipeline',
    'voice_realtime',
  ];

  it('contains all expected channel types', () => {
    for (const channel of EXPECTED_CHANNELS) {
      expect(CHANNEL_MANIFEST[channel], `Missing manifest entry for "${channel}"`).toBeDefined();
    }
  });

  it('does not contain jambonz', () => {
    expect(CHANNEL_MANIFEST['jambonz']).toBeUndefined();
  });

  it('has exactly the expected number of channels', () => {
    expect(Object.keys(CHANNEL_MANIFEST).sort()).toEqual(EXPECTED_CHANNELS.sort());
  });
});

// =============================================================================
// SPECIFIC CHANNEL LOOKUPS
// =============================================================================

describe('getChannelManifest', () => {
  it('returns correct entry for slack', () => {
    const slack = getChannelManifest('slack');
    expect(slack).toBeDefined();
    expect(slack!.displayName).toBe('Slack');
    expect(slack!.authMode).toBe('hmac');
    expect(slack!.ingress).toBe('webhook');
    expect(slack!.delivery).toBe('async_queue');
    expect(slack!.responseFormat).toBe('blocks');
    expect(slack!.supportsRichOutput).toBe(true);
    expect(slack!.supportsThreading).toBe(true);
    expect(slack!.supportsMedia).toBe(true);
    expect(slack!.supportsStreaming).toBe(true);
    expect(slack!.isConnectionEligible).toBe(true);
    expect(slack!.isVoice).toBe(false);
  });

  it('returns correct entry for line', () => {
    const line = getChannelManifest('line');
    expect(line).toBeDefined();
    expect(line!.displayName).toBe('LINE');
    expect(line!.authMode).toBe('hmac');
    expect(line!.ingress).toBe('webhook');
    expect(line!.delivery).toBe('async_queue');
    expect(line!.responseFormat).toBe('text');
    expect(line!.supportsRichOutput).toBe(true);
    expect(line!.supportsMedia).toBe(true);
    expect(line!.supportsTypingIndicator).toBe(true);
    expect(line!.requiredCredentials).toEqual(['channel_access_token', 'channel_secret']);
    expect(line!.webhookPathPattern).toBe('/api/v1/channels/line/webhook');
  });

  it('returns correct entry for voice_vxml (voice)', () => {
    const vxml = getChannelManifest('voice_vxml');
    expect(vxml).toBeDefined();
    expect(vxml!.isVoice).toBe(true);
    expect(vxml!.ingress).toBe('sync_webhook');
    expect(vxml!.delivery).toBe('sync_response');
    expect(vxml!.authMode).toBe('token');
    expect(vxml!.responseFormat).toBe('voice_plain');
    expect(vxml!.isConnectionEligible).toBe(true);
    expect(vxml!.webhookPathPattern).toBe('/api/v1/channels/vxml/hooks/:streamId');
  });

  it('returns correct entry for msteams', () => {
    const teams = getChannelManifest('msteams');
    expect(teams).toBeDefined();
    expect(teams!.authMode).toBe('jwt');
    expect(teams!.responseFormat).toBe('adaptive_card');
    expect(teams!.requiredCredentials).toEqual(['app_id', 'client_secret', 'tenant_id']);
  });

  it('returns correct entry for whatsapp', () => {
    const wa = getChannelManifest('whatsapp');
    expect(wa).toBeDefined();
    expect(wa!.authMode).toBe('hmac');
    expect(wa!.responseFormat).toBe('interactive');
    expect(wa!.requiredCredentials).toEqual(['access_token', 'app_secret', 'verify_token']);
  });

  it('returns correct entry for messenger', () => {
    const msg = getChannelManifest('messenger');
    expect(msg).toBeDefined();
    expect(msg!.authMode).toBe('hmac');
    expect(msg!.responseFormat).toBe('template');
    expect(msg!.requiredCredentials).toEqual(['page_access_token', 'app_secret', 'verify_token']);
  });

  it('returns correct entry for twilio_sms', () => {
    const sms = getChannelManifest('twilio_sms');
    expect(sms).toBeDefined();
    expect(sms!.displayName).toBe('Twilio SMS');
    expect(sms!.ingress).toBe('webhook');
    expect(sms!.delivery).toBe('async_queue');
    expect(sms!.authMode).toBe('hmac');
    expect(sms!.responseFormat).toBe('text');
    expect(sms!.supportsRichOutput).toBe(false);
    expect(sms!.supportsMedia).toBe(true);
    expect(sms!.isConnectionEligible).toBe(true);
    expect(sms!.isVoice).toBe(false);
    expect(sms!.requiredCredentials).toEqual(['account_sid', 'auth_token']);
    expect(sms!.webhookPathPattern).toBe('/api/v1/channels/twilio_sms/webhook/:identifier');
  });

  it('returns correct entry for email', () => {
    const email = getChannelManifest('email');
    expect(email).toBeDefined();
    expect(email!.ingress).toBe('smtp');
    expect(email!.authMode).toBe('none');
    expect(email!.responseFormat).toBe('markdown');
    expect(email!.supportsThreading).toBe(true);
    expect(email!.supportsMedia).toBe(true);
    expect(email!.requiredCredentials).toEqual([]);
  });

  it('returns correct entry for ag_ui', () => {
    const agUi = getChannelManifest('ag_ui');
    expect(agUi).toBeDefined();
    expect(agUi!.ingress).toBe('websocket');
    expect(agUi!.authMode).toBe('sdk_auth');
    expect(agUi!.responseFormat).toBe('ag_ui_events');
    expect(agUi!.supportsRichOutput).toBe(true);
    expect(agUi!.supportsStreaming).toBe(true);
    expect(agUi!.isConnectionEligible).toBe(true);
  });

  it('returns correct entry for voice_twilio', () => {
    const twilio = getChannelManifest('voice_twilio');
    expect(twilio).toBeDefined();
    expect(twilio!.isVoice).toBe(true);
    expect(twilio!.ingress).toBe('webhook');
    expect(twilio!.delivery).toBe('websocket');
    expect(twilio!.authMode).toBe('hmac');
    expect(twilio!.isConnectionEligible).toBe(true);
    expect(twilio!.webhookPathPattern).toBe('/api/v1/voice/connect');
  });

  it('returns correct entry for voice_livekit', () => {
    const livekit = getChannelManifest('voice_livekit');
    expect(livekit).toBeDefined();
    expect(livekit!.isVoice).toBe(true);
    expect(livekit!.ingress).toBe('websocket');
    expect(livekit!.isConnectionEligible).toBe(false);
  });

  it('returns correct entry for korevg', () => {
    const kvg = getChannelManifest('korevg');
    expect(kvg).toBeDefined();
    expect(kvg!.isVoice).toBe(true);
    expect(kvg!.ingress).toBe('websocket');
    expect(kvg!.delivery).toBe('websocket');
    expect(kvg!.authMode).toBe('token');
    expect(kvg!.supportsStreaming).toBe(true);
    expect(kvg!.isConnectionEligible).toBe(true);
  });

  it('returns correct entry for sdk_websocket', () => {
    const sdk = getChannelManifest('sdk_websocket');
    expect(sdk).toBeDefined();
    expect(sdk!.ingress).toBe('websocket');
    expect(sdk!.authMode).toBe('sdk_auth');
    expect(sdk!.responseFormat).toBe('markdown');
    expect(sdk!.isConnectionEligible).toBe(false);
  });

  it('returns correct entry for web_debug', () => {
    const debug = getChannelManifest('web_debug');
    expect(debug).toBeDefined();
    expect(debug!.authMode).toBe('none');
    expect(debug!.responseFormat).toBe('markdown');
    expect(debug!.isConnectionEligible).toBe(false);
  });

  it('returns correct entry for a2a', () => {
    const a2a = getChannelManifest('a2a');
    expect(a2a).toBeDefined();
    expect(a2a!.ingress).toBe('api');
    expect(a2a!.delivery).toBe('async_queue');
    expect(a2a!.supportsStreaming).toBe(true);
    expect(a2a!.isConnectionEligible).toBe(true);
  });

  it('returns correct entry for genesys', () => {
    const genesys = getChannelManifest('genesys');
    expect(genesys).toBeDefined();
    expect(genesys!.displayName).toBe('Genesys');
    expect(genesys!.ingress).toBe('sync_webhook');
    expect(genesys!.delivery).toBe('sync_response');
    expect(genesys!.authMode).toBe('token');
    expect(genesys!.responseFormat).toBe('text');
    expect(genesys!.supportsRichOutput).toBe(true);
    expect(genesys!.isConnectionEligible).toBe(true);
    expect(genesys!.isVoice).toBe(false);
    expect(genesys!.requiredCredentials).toEqual(['client_secret']);
    expect(genesys!.webhookPathPattern).toBe('/api/v1/channels/genesys/hooks/:streamId');
  });

  it('returns undefined for unknown channel', () => {
    expect(getChannelManifest('nonexistent')).toBeUndefined();
  });

  it('returns undefined for jambonz', () => {
    expect(getChannelManifest('jambonz')).toBeUndefined();
  });
});

// =============================================================================
// RESPONSE FORMAT PER CHANNEL
// =============================================================================

describe('response format per channel', () => {
  const expectedFormats: Record<string, string> = {
    http_async: 'text',
    slack: 'blocks',
    line: 'text',
    msteams: 'adaptive_card',
    whatsapp: 'interactive',
    messenger: 'template',
    instagram: 'template',
    twilio_sms: 'text',
    zendesk: 'text',
    telegram: 'text',
    genesys: 'text',
    email: 'markdown',
    voice_vxml: 'voice_plain',
    korevg: 'voice_plain',
    audiocodes: 'voice_plain',
    ag_ui: 'ag_ui_events',
    a2a: 'text',
    sdk_websocket: 'markdown',
    web_debug: 'markdown',
    web_chat: 'markdown',
    api: 'text',
    http: 'text',
    voice: 'voice_plain',
    voice_twilio: 'voice_plain',
    voice_livekit: 'voice_plain',
    voice_pipeline: 'voice_plain',
    voice_realtime: 'voice_plain',
  };

  for (const [channel, format] of Object.entries(expectedFormats)) {
    it(`${channel} has responseFormat "${format}"`, () => {
      expect(getChannelManifest(channel)!.responseFormat).toBe(format);
    });
  }
});

// =============================================================================
// DERIVED TYPE LISTS
// =============================================================================

describe('getWebhookChannelTypes', () => {
  it('returns channels with webhook or sync_webhook ingress', () => {
    const webhookTypes = getWebhookChannelTypes();
    // Standard webhooks
    expect(webhookTypes).toContain('slack');
    expect(webhookTypes).toContain('line');
    expect(webhookTypes).toContain('msteams');
    expect(webhookTypes).toContain('whatsapp');
    expect(webhookTypes).toContain('messenger');
    expect(webhookTypes).toContain('voice_twilio');
    expect(webhookTypes).toContain('twilio_sms');
    // Sync webhook
    expect(webhookTypes).toContain('voice_vxml');
    expect(webhookTypes).toContain('genesys');
    // Should NOT contain non-webhook types
    expect(webhookTypes).not.toContain('web_debug');
    expect(webhookTypes).not.toContain('sdk_websocket');
    expect(webhookTypes).not.toContain('api');
    expect(webhookTypes).not.toContain('email');
  });
});

describe('getRealtimeChannelTypes', () => {
  it('returns channels with websocket ingress', () => {
    const realtimeTypes = getRealtimeChannelTypes();
    expect(realtimeTypes).toContain('sdk_websocket');
    expect(realtimeTypes).toContain('web_debug');
    expect(realtimeTypes).toContain('web_chat');
    expect(realtimeTypes).toContain('ag_ui');
    expect(realtimeTypes).toContain('korevg');
    expect(realtimeTypes).toContain('voice');
    expect(realtimeTypes).toContain('voice_livekit');
    expect(realtimeTypes).toContain('voice_pipeline');
    // Should NOT contain non-websocket types
    expect(realtimeTypes).not.toContain('slack');
    expect(realtimeTypes).not.toContain('http_async');
    expect(realtimeTypes).not.toContain('email');
  });
});

describe('getConnectionChannelTypes', () => {
  it('returns connection-eligible channels', () => {
    const connectionTypes = getConnectionChannelTypes();
    // Connection-eligible
    expect(connectionTypes).toContain('http_async');
    expect(connectionTypes).toContain('slack');
    expect(connectionTypes).toContain('line');
    expect(connectionTypes).toContain('msteams');
    expect(connectionTypes).toContain('whatsapp');
    expect(connectionTypes).toContain('messenger');
    expect(connectionTypes).toContain('email');
    expect(connectionTypes).toContain('voice_vxml');
    expect(connectionTypes).toContain('korevg');
    expect(connectionTypes).toContain('ag_ui');
    expect(connectionTypes).toContain('a2a');
    expect(connectionTypes).toContain('genesys');
    expect(connectionTypes).toContain('twilio_sms');
    expect(connectionTypes).toContain('voice_twilio');
    expect(connectionTypes).toContain('voice_pipeline');
    // NOT connection-eligible
    expect(connectionTypes).not.toContain('web_debug');
    expect(connectionTypes).not.toContain('web_chat');
    expect(connectionTypes).not.toContain('sdk_websocket');
    expect(connectionTypes).not.toContain('api');
    expect(connectionTypes).not.toContain('http');
    expect(connectionTypes).not.toContain('voice');
    expect(connectionTypes).not.toContain('voice_livekit');
  });
});

describe('getVoiceChannelTypes', () => {
  it('returns all voice channels', () => {
    const voiceTypes = getVoiceChannelTypes();
    expect(voiceTypes).toContain('voice_vxml');
    expect(voiceTypes).toContain('korevg');
    expect(voiceTypes).toContain('voice');
    expect(voiceTypes).toContain('voice_twilio');
    expect(voiceTypes).toContain('voice_livekit');
    expect(voiceTypes).toContain('voice_pipeline');
    // NOT voice
    expect(voiceTypes).not.toContain('twilio_sms');
    expect(voiceTypes).not.toContain('slack');
    expect(voiceTypes).not.toContain('web_debug');
    expect(voiceTypes).not.toContain('ag_ui');
  });
});

// =============================================================================
// BACKWARD-COMPATIBLE DERIVED SETS
// =============================================================================

describe('backward-compatible derived sets', () => {
  it('CONNECTION_CAPABLE_TYPES matches getConnectionChannelTypes', () => {
    expect([...CONNECTION_CAPABLE_TYPES].sort()).toEqual(getConnectionChannelTypes().sort());
  });

  it('WEBHOOK_CAPABLE_TYPES matches getWebhookChannelTypes', () => {
    const fromHelper = new Set(getWebhookChannelTypes());
    expect(WEBHOOK_CAPABLE_TYPES).toEqual(fromHelper);
  });

  it('META_WEBHOOK_TYPES contains whatsapp and messenger', () => {
    expect(META_WEBHOOK_TYPES.has('whatsapp')).toBe(true);
    expect(META_WEBHOOK_TYPES.has('messenger')).toBe(true);
    // Slack uses hmac but does not have verify_token
    expect(META_WEBHOOK_TYPES.has('slack')).toBe(false);
  });

  it('VOICE_TYPES matches getVoiceChannelTypes', () => {
    const fromHelper = new Set(getVoiceChannelTypes());
    expect(VOICE_TYPES).toEqual(fromHelper);
  });
});

// =============================================================================
// CREDENTIAL REQUIREMENTS
// =============================================================================

describe('getRequiredCredentials', () => {
  it('returns bot_token and signing_secret for slack', () => {
    expect(getRequiredCredentials('slack')).toEqual(['bot_token', 'signing_secret']);
  });

  it('returns app_id, client_secret, tenant_id for msteams', () => {
    expect(getRequiredCredentials('msteams')).toEqual(['app_id', 'client_secret', 'tenant_id']);
  });

  it('returns access_token, app_secret, verify_token for whatsapp', () => {
    expect(getRequiredCredentials('whatsapp')).toEqual([
      'access_token',
      'app_secret',
      'verify_token',
    ]);
  });

  it('returns page_access_token, app_secret, verify_token for messenger', () => {
    expect(getRequiredCredentials('messenger')).toEqual([
      'page_access_token',
      'app_secret',
      'verify_token',
    ]);
  });

  it('returns account_sid and auth_token for twilio_sms', () => {
    expect(getRequiredCredentials('twilio_sms')).toEqual(['account_sid', 'auth_token']);
  });

  it('returns empty array for email (no credentials required)', () => {
    expect(getRequiredCredentials('email')).toEqual([]);
  });

  it('returns empty array for http_async', () => {
    expect(getRequiredCredentials('http_async')).toEqual([]);
  });

  it('returns empty array for unknown channel', () => {
    expect(getRequiredCredentials('nonexistent')).toEqual([]);
  });

  it('returns a new array each call (not a reference to internal state)', () => {
    const a = getRequiredCredentials('slack');
    const b = getRequiredCredentials('slack');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

// =============================================================================
// isKnownChannelType
// =============================================================================

describe('isKnownChannelType', () => {
  it('returns true for known channels', () => {
    expect(isKnownChannelType('slack')).toBe(true);
    expect(isKnownChannelType('web_debug')).toBe(true);
    expect(isKnownChannelType('voice_twilio')).toBe(true);
  });

  it('returns false for unknown channels', () => {
    expect(isKnownChannelType('jambonz')).toBe(false);
    expect(isKnownChannelType('nonexistent')).toBe(false);
    expect(isKnownChannelType('')).toBe(false);
  });
});

// =============================================================================
// WEBHOOK URL BUILDER
// =============================================================================

describe('buildWebhookUrl', () => {
  const BASE = 'https://runtime.example.com';

  it('generates correct Slack webhook URL with identifier', () => {
    expect(buildWebhookUrl('slack', BASE, 'conn-123')).toBe(
      'https://runtime.example.com/api/v1/channels/slack/webhook/conn-123',
    );
  });

  it('generates correct MS Teams webhook URL with identifier', () => {
    expect(buildWebhookUrl('msteams', BASE, 'teams-abc')).toBe(
      'https://runtime.example.com/api/v1/channels/msteams/webhook/teams-abc',
    );
  });

  it('generates correct WhatsApp webhook URL (no identifier placeholder)', () => {
    expect(buildWebhookUrl('whatsapp', BASE)).toBe(
      'https://runtime.example.com/api/v1/channels/whatsapp/webhook',
    );
  });

  it('generates correct Messenger webhook URL (no identifier placeholder)', () => {
    expect(buildWebhookUrl('messenger', BASE)).toBe(
      'https://runtime.example.com/api/v1/channels/messenger/webhook',
    );
  });

  it('generates correct VXML webhook URL with streamId', () => {
    expect(buildWebhookUrl('voice_vxml', BASE, 'stream-456')).toBe(
      'https://runtime.example.com/api/v1/channels/vxml/hooks/stream-456',
    );
  });

  it('generates correct Genesys webhook URL with streamId', () => {
    expect(buildWebhookUrl('genesys', BASE, 'stream-789')).toBe(
      'https://runtime.example.com/api/v1/channels/genesys/hooks/stream-789',
    );
  });

  it('generates correct Twilio SMS webhook URL with identifier', () => {
    expect(buildWebhookUrl('twilio_sms', BASE, 'conn-abc')).toBe(
      'https://runtime.example.com/api/v1/channels/twilio_sms/webhook/conn-abc',
    );
  });

  it('generates correct voice_twilio webhook URL', () => {
    expect(buildWebhookUrl('voice_twilio', BASE)).toBe(
      'https://runtime.example.com/api/v1/voice/connect',
    );
  });

  it('strips trailing slash from base URL', () => {
    expect(buildWebhookUrl('slack', 'https://example.com/', 'id')).toBe(
      'https://example.com/api/v1/channels/slack/webhook/id',
    );
  });

  it('encodes identifier for URL safety', () => {
    expect(buildWebhookUrl('slack', BASE, 'has spaces/and&chars')).toBe(
      'https://runtime.example.com/api/v1/channels/slack/webhook/has%20spaces%2Fand%26chars',
    );
  });

  it('strips unresolved params when no identifier given for slack', () => {
    expect(buildWebhookUrl('slack', BASE)).toBe(
      'https://runtime.example.com/api/v1/channels/slack/webhook',
    );
  });

  it('strips unresolved params when no identifier given for voice_vxml', () => {
    expect(buildWebhookUrl('voice_vxml', BASE)).toBe(
      'https://runtime.example.com/api/v1/channels/vxml/hooks',
    );
  });

  it('returns null for channels without webhook path', () => {
    expect(buildWebhookUrl('web_debug', BASE)).toBeNull();
    expect(buildWebhookUrl('sdk_websocket', BASE)).toBeNull();
    expect(buildWebhookUrl('korevg', BASE)).toBeNull();
    expect(buildWebhookUrl('email', BASE)).toBeNull();
    expect(buildWebhookUrl('api', BASE)).toBeNull();
  });

  it('returns null for unknown channel', () => {
    expect(buildWebhookUrl('nonexistent', BASE)).toBeNull();
  });
});
