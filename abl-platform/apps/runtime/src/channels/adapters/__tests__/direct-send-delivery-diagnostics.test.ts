import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI4WAdapter } from '../ai4w-adapter.js';
import { EmailAdapter } from '../email-adapter.js';
import { GupshupProvider } from '../whatsapp-providers/gupshup-provider.js';
import { InfobipProvider } from '../whatsapp-providers/infobip-provider.js';
import { MetaCloudProvider } from '../whatsapp-providers/meta-cloud-provider.js';
import { NetcoreProvider } from '../whatsapp-providers/netcore-provider.js';
import { InstagramAdapter } from '../instagram-adapter.js';
import { LineAdapter } from '../line-adapter.js';
import { MSTeamsAdapter } from '../msteams-adapter.js';
import { TelegramAdapter } from '../telegram-adapter.js';
import { TwilioSmsAdapter } from '../twilio-sms-adapter.js';
import { ZendeskAdapter } from '../zendesk-adapter.js';
import type {
  ChannelType,
  NormalizedOutgoingMessage,
  ResolvedConnection,
  SendResult,
} from '../../types.js';

const fetchMock = vi.fn();

const SAFE_CUSTOMER_MESSAGE = "I'm having trouble delivering that response. Please try again.";

function makeConnection(
  channelType: ChannelType,
  overrides?: Partial<ResolvedConnection>,
): ResolvedConnection {
  return {
    id: `conn-${channelType}`,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    channelType,
    externalIdentifier: 'external-1',
    credentials: {},
    config: {},
    status: 'active',
    ...overrides,
  };
}

function makeMessage(metadata: Record<string, unknown>): NormalizedOutgoingMessage {
  return {
    sessionId: 'session-1',
    text: 'Hello from the agent',
    eventType: 'agent.response',
    metadata,
  };
}

function expectSanitizedProviderFailure(
  result: SendResult,
  channelType: ChannelType,
  provider: string,
): void {
  expect(result.success).toBe(false);
  expect(result.error).toBe(SAFE_CUSTOMER_MESSAGE);
  expect(result.metadata?.channelDiagnostic).toMatchObject({
    source: 'channel_delivery',
    category: 'provider',
    severity: 'error',
    code: 'CHANNEL_PROVIDER_REJECTED',
    channelType,
    provider,
    retryable: false,
  });
  expect(result.metadata?.errorEnvelope).toMatchObject({
    code: 'CHANNEL_PROVIDER_REJECTED',
    category: 'runtime',
    customer_message: SAFE_CUSTOMER_MESSAGE,
  });
}

function expectSanitizedFailure(
  result: SendResult,
  expected: {
    channelType: ChannelType;
    provider: string;
    category: string;
    code: string;
    customerMessage?: string;
    retryable: boolean;
  },
): void {
  const customerMessage = expected.customerMessage ?? SAFE_CUSTOMER_MESSAGE;
  expect(result.success).toBe(false);
  expect(result.error).toBe(customerMessage);
  expect(result.metadata?.channelDiagnostic).toMatchObject({
    source: 'channel_delivery',
    category: expected.category,
    severity: 'error',
    code: expected.code,
    channelType: expected.channelType,
    provider: expected.provider,
    retryable: expected.retryable,
  });
  expect(result.metadata?.errorEnvelope).toMatchObject({
    code: expected.code,
    category: 'runtime',
    customer_message: customerMessage,
  });
}

describe('direct-send adapter delivery diagnostics', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('LINE_CHANNEL_ACCESS_TOKEN', '');
    vi.stubEnv('INSTAGRAM_PAGE_ACCESS_TOKEN', '');
    vi.stubEnv('MSTEAMS_APP_ID', '');
    vi.stubEnv('MSTEAMS_CLIENT_SECRET', '');
    vi.stubEnv('MSTEAMS_TENANT_ID', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('normalizes Telegram provider rejections without exposing raw provider text', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized bot-secret-token tenant_abc'),
    } as Response);

    const result = await new TelegramAdapter().sendResponse(
      makeMessage({ telegramChatId: 123 }),
      makeConnection('telegram', { credentials: { bot_token: 'bot-secret-token' } }),
    );

    expectSanitizedProviderFailure(result, 'telegram', 'telegram');
    expect(JSON.stringify(result)).not.toContain('bot-secret-token');
    expect(JSON.stringify(result)).not.toContain('tenant_abc');
  });

  it('normalizes LINE reply and push delivery failures', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Invalid channel access token line-secret-token'),
    } as Response);

    const result = await new LineAdapter().sendResponse(
      makeMessage({ lineReplyToken: 'reply-token' }),
      makeConnection('line', { credentials: { channel_access_token: 'line-secret-token' } }),
    );

    expectSanitizedProviderFailure(result, 'line', 'line');
    expect(JSON.stringify(result)).not.toContain('line-secret-token');
  });

  it('normalizes Instagram messaging-window provider failures', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve('Cannot send message with page-secret-token outside messaging window'),
    } as Response);

    const result = await new InstagramAdapter().sendResponse(
      makeMessage({ instagramSenderId: 'sender-1' }),
      makeConnection('instagram', {
        externalIdentifier: 'ig-user-1',
        credentials: { page_access_token: 'page-secret-token' },
      }),
    );

    expectSanitizedProviderFailure(result, 'instagram', 'instagram');
    expect(JSON.stringify(result)).not.toContain('page-secret-token');
    expect(JSON.stringify(result)).not.toContain('Cannot send message');
  });

  it('normalizes Twilio provider failures without leaking auth material', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Bad auth token twilio-secret-token'),
    } as Response);

    const result = await new TwilioSmsAdapter().sendResponse(
      makeMessage({ twilioFrom: '+15551234567', twilioTo: '+15557654321' }),
      makeConnection('twilio_sms', {
        credentials: {
          account_sid: 'AC123',
          auth_token: 'twilio-secret-token',
        },
      }),
    );

    expectSanitizedProviderFailure(result, 'twilio_sms', 'twilio');
    expect(JSON.stringify(result)).not.toContain('twilio-secret-token');
  });

  it('normalizes Zendesk provider failures without leaking key secrets', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Zendesk key_secret zendesk-secret failed'),
    } as Response);

    const result = await new ZendeskAdapter().sendResponse(
      makeMessage({ zendeskAppId: 'app-1', zendeskConversationId: 'conversation-1' }),
      makeConnection('zendesk', {
        credentials: {
          key_id: 'key-1',
          key_secret: 'zendesk-secret',
        },
      }),
    );

    expectSanitizedProviderFailure(result, 'zendesk', 'zendesk');
    expect(JSON.stringify(result)).not.toContain('zendesk-secret');
  });

  it('normalizes Teams configuration failures', async () => {
    const result = await new MSTeamsAdapter().sendResponse(
      makeMessage({
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        conversationId: 'conversation-1',
        activityId: 'activity-1',
      }),
      makeConnection('msteams'),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'This channel is not fully configured for response delivery. Please contact support.',
    );
    expect(result.metadata?.channelDiagnostic).toMatchObject({
      category: 'configuration',
      code: 'CHANNEL_DELIVERY_CONFIGURATION',
      channelType: 'msteams',
      provider: 'msteams',
      retryable: false,
    });
    expect(result.error).not.toContain('client_secret');
  });

  it('normalizes email metadata and transport configuration failures', async () => {
    const missingRecipient = await new EmailAdapter().sendResponse(
      makeMessage({}),
      makeConnection('email'),
    );

    expectSanitizedFailure(missingRecipient, {
      channelType: 'email',
      provider: 'email',
      category: 'metadata',
      code: 'CHANNEL_DELIVERY_METADATA',
      retryable: false,
    });

    const missingGraphSecret = await new EmailAdapter().sendResponse(
      makeMessage({
        from: 'customer@example.com',
        subject: 'Need help',
      }),
      makeConnection('email', {
        externalIdentifier: 'agent@example.com',
        config: {
          outbound: {
            transport: 'graph',
            graph: {
              tenantId: 'tenant_abc',
              clientId: 'client_123',
              senderAddress: 'agent@example.com',
            },
          },
        },
      }),
    );

    expectSanitizedFailure(missingGraphSecret, {
      channelType: 'email',
      provider: 'email',
      category: 'configuration',
      code: 'CHANNEL_DELIVERY_CONFIGURATION',
      customerMessage:
        'This channel is not fully configured for response delivery. Please contact support.',
      retryable: false,
    });
    expect(JSON.stringify(missingGraphSecret)).not.toContain('graph_client_secret');
    expect(JSON.stringify(missingGraphSecret)).not.toContain('tenant_abc');
  });

  it('normalizes AI4W async delivery configuration failures', async () => {
    const missingSecret = await new AI4WAdapter().sendResponse(
      makeMessage({ responseMode: 'async' }),
      makeConnection('ai4w', {
        config: { callbackBaseUrl: 'https://ai4w.example/callback' },
      }),
    );

    expectSanitizedFailure(missingSecret, {
      channelType: 'ai4w',
      provider: 'ai4w',
      category: 'configuration',
      code: 'CHANNEL_DELIVERY_CONFIGURATION',
      customerMessage:
        'This channel is not fully configured for response delivery. Please contact support.',
      retryable: false,
    });
    expect(JSON.stringify(missingSecret)).not.toContain('connectionSecret');

    const missingCallback = await new AI4WAdapter().sendResponse(
      makeMessage({ responseMode: 'async' }),
      makeConnection('ai4w', {
        credentials: { connectionSecret: 'ai4w-secret' },
      }),
    );

    expectSanitizedFailure(missingCallback, {
      channelType: 'ai4w',
      provider: 'ai4w',
      category: 'configuration',
      code: 'CHANNEL_DELIVERY_CONFIGURATION',
      customerMessage:
        'This channel is not fully configured for response delivery. Please contact support.',
      retryable: false,
    });
    expect(JSON.stringify(missingCallback)).not.toContain('ai4w-secret');
  });

  it('normalizes WhatsApp provider rejections without exposing provider details', async () => {
    const whatsappMessage = makeMessage({ whatsappFrom: '+15557654321' });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Meta access_token whatsapp-secret tenant_abc'),
    } as Response);
    const metaResult = await new MetaCloudProvider().sendResponse(
      whatsappMessage,
      makeConnection('whatsapp', {
        externalIdentifier: 'phone-number-id',
        credentials: { access_token: 'whatsapp-secret' },
      }),
    );
    expectSanitizedProviderFailure(metaResult, 'whatsapp', 'meta_cloud');

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Infobip api key infobip-secret rejected'),
    } as Response);
    const infobipResult = await new InfobipProvider().sendResponse(
      whatsappMessage,
      makeConnection('whatsapp', {
        externalIdentifier: '+15551234567',
        credentials: { base_url: 'https://infobip.example', api_key: 'infobip-secret' },
      }),
    );
    expectSanitizedProviderFailure(infobipResult, 'whatsapp', 'infobip');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          response: { status: 'error', details: 'Netcore api key netcore-secret rejected' },
        }),
    } as Response);
    const netcoreResult = await new NetcoreProvider().sendResponse(
      whatsappMessage,
      makeConnection('whatsapp', {
        externalIdentifier: '+15551234567',
        credentials: { api_key: 'netcore-secret' },
      }),
    );
    expectSanitizedProviderFailure(netcoreResult, 'whatsapp', 'netcore');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          response: { status: 'error', details: 'Gupshup password gupshup-secret rejected' },
        }),
    } as Response);
    const gupshupResult = await new GupshupProvider().sendResponse(
      whatsappMessage,
      makeConnection('whatsapp', {
        externalIdentifier: '+15551234567',
        credentials: { username: 'user-1', password: 'gupshup-secret' },
      }),
    );
    expectSanitizedProviderFailure(gupshupResult, 'whatsapp', 'gupshup');

    const serialized = JSON.stringify([metaResult, infobipResult, netcoreResult, gupshupResult]);
    expect(serialized).not.toContain('whatsapp-secret');
    expect(serialized).not.toContain('tenant_abc');
    expect(serialized).not.toContain('infobip-secret');
    expect(serialized).not.toContain('netcore-secret');
    expect(serialized).not.toContain('gupshup-secret');
  });
});
