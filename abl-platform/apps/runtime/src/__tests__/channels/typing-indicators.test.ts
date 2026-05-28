/**
 * Typing Indicators -- Unit Tests
 *
 * Tests for:
 * 1. Adapter sendTypingIndicator methods (Messenger, MS Teams, Telegram)
 * 2. Slack adapter does NOT have sendTypingIndicator
 * 3. Channel manifest supportsTypingIndicator flags
 * 4. ServerMessages.typingStart shape
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessengerAdapter } from '../../channels/adapters/messenger-adapter.js';
import { MSTeamsAdapter } from '../../channels/adapters/msteams-adapter.js';
import { TelegramAdapter } from '../../channels/adapters/telegram-adapter.js';
import { LineAdapter } from '../../channels/adapters/line-adapter.js';
import { SlackAdapter } from '../../channels/adapters/slack-adapter.js';
import { CHANNEL_MANIFEST } from '../../channels/manifest.js';
import { ServerMessages } from '../../websocket/events.js';
import type { ResolvedConnection } from '../../channels/types.js';

// =============================================================================
// MOCKS
// =============================================================================

vi.stubGlobal('fetch', vi.fn());
const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;

vi.mock('../../channels/adapters/msteams-auth.js', () => ({
  getBotFrameworkToken: vi.fn().mockResolvedValue('mock-token'),
}));

// =============================================================================
// FIXTURES
// =============================================================================

const messengerConnection: ResolvedConnection = {
  id: 'conn-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  agentId: 'agent-1',
  channelType: 'messenger',
  externalIdentifier: 'page-123',
  credentials: {
    page_access_token: 'test-token',
    app_secret: 'test-secret',
    verify_token: 'test-verify',
  },
  config: {},
  status: 'active',
};

const teamsConnection: ResolvedConnection = {
  id: 'conn-2',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  agentId: 'agent-1',
  channelType: 'msteams',
  externalIdentifier: 'bot-123',
  credentials: {
    app_id: 'test-app',
    client_secret: 'test-secret',
    tenant_id: 'test-tenant',
  },
  config: {},
  status: 'active',
};

const telegramConnection: ResolvedConnection = {
  id: 'conn-3',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  agentId: 'agent-1',
  channelType: 'telegram',
  externalIdentifier: 'mybot',
  credentials: { bot_token: 'test-bot-token' },
  config: {},
  status: 'active',
};

const lineConnection: ResolvedConnection = {
  id: 'conn-4',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  agentId: 'agent-1',
  channelType: 'line',
  externalIdentifier: 'Ubotdestination',
  credentials: {
    channel_access_token: 'line-access-token',
    channel_secret: 'line-secret',
  },
  config: {},
  status: 'active',
};

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

function errorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

// =============================================================================
// MESSENGER ADAPTER -- sendTypingIndicator
// =============================================================================

describe('MessengerAdapter.sendTypingIndicator', () => {
  let adapter: MessengerAdapter;

  beforeEach(() => {
    adapter = new MessengerAdapter();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends correct HTTP request to Graph API', async () => {
    mockFetch.mockResolvedValue(okResponse());

    await adapter.sendTypingIndicator(messengerConnection, 'session-1', {
      messengerSenderId: 'user-456',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('graph.facebook.com');
    expect(url).toContain('/me/messages');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer test-token');
    expect(options.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(options.body);
    expect(body).toEqual({
      recipient: { id: 'user-456' },
      sender_action: 'typing_on',
    });
  });

  it('returns void (does not throw) when API returns error response', async () => {
    mockFetch.mockResolvedValue(errorResponse(500, 'Internal Server Error'));

    await expect(
      adapter.sendTypingIndicator(messengerConnection, 'session-1', {
        messengerSenderId: 'user-456',
      }),
    ).resolves.toBeUndefined();
  });

  it('returns void (does not throw) when credentials are missing', async () => {
    const noCredConn: ResolvedConnection = {
      ...messengerConnection,
      credentials: null,
    };
    // Also clear env var to make sure no fallback
    const orig = process.env.MESSENGER_PAGE_ACCESS_TOKEN;
    delete process.env.MESSENGER_PAGE_ACCESS_TOKEN;

    await expect(
      adapter.sendTypingIndicator(noCredConn, 'session-1', {
        messengerSenderId: 'user-456',
      }),
    ).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();

    // Restore
    if (orig !== undefined) process.env.MESSENGER_PAGE_ACCESS_TOKEN = orig;
  });

  it('returns void (does not throw) when metadata is missing recipientId', async () => {
    await expect(
      adapter.sendTypingIndicator(messengerConnection, 'session-1', {}),
    ).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns void (does not throw) when metadata is undefined', async () => {
    await expect(
      adapter.sendTypingIndicator(messengerConnection, 'session-1', undefined),
    ).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// =============================================================================
// MS TEAMS ADAPTER -- sendTypingIndicator
// =============================================================================

describe('MSTeamsAdapter.sendTypingIndicator', () => {
  let adapter: MSTeamsAdapter;

  beforeEach(() => {
    adapter = new MSTeamsAdapter();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends correct HTTP request to Bot Framework', async () => {
    mockFetch.mockResolvedValue(okResponse());

    await adapter.sendTypingIndicator(teamsConnection, 'session-1', {
      serviceUrl: 'https://smba.trafficmanager.net/teams/',
      conversationId: 'conv-789',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://smba.trafficmanager.net/teams/v3/conversations/conv-789/activities');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer mock-token');
    expect(options.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(options.body);
    expect(body).toEqual({ type: 'typing' });
  });

  it('normalizes serviceUrl without trailing slash', async () => {
    mockFetch.mockResolvedValue(okResponse());

    await adapter.sendTypingIndicator(teamsConnection, 'session-1', {
      serviceUrl: 'https://smba.trafficmanager.net/teams',
      conversationId: 'conv-789',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://smba.trafficmanager.net/teams/v3/conversations/conv-789/activities');
  });

  it('returns void (does not throw) on API failure', async () => {
    mockFetch.mockResolvedValue(errorResponse(403, 'Forbidden'));

    await expect(
      adapter.sendTypingIndicator(teamsConnection, 'session-1', {
        serviceUrl: 'https://smba.trafficmanager.net/teams/',
        conversationId: 'conv-789',
      }),
    ).resolves.toBeUndefined();
  });

  it('returns void (does not throw) when credentials are missing', async () => {
    const noCredConn: ResolvedConnection = {
      ...teamsConnection,
      credentials: null,
    };
    const origAppId = process.env.MSTEAMS_APP_ID;
    const origSecret = process.env.MSTEAMS_CLIENT_SECRET;
    const origTenant = process.env.MSTEAMS_TENANT_ID;
    delete process.env.MSTEAMS_APP_ID;
    delete process.env.MSTEAMS_CLIENT_SECRET;
    delete process.env.MSTEAMS_TENANT_ID;

    await expect(
      adapter.sendTypingIndicator(noCredConn, 'session-1', {
        serviceUrl: 'https://smba.trafficmanager.net/teams/',
        conversationId: 'conv-789',
      }),
    ).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();

    // Restore
    if (origAppId !== undefined) process.env.MSTEAMS_APP_ID = origAppId;
    if (origSecret !== undefined) process.env.MSTEAMS_CLIENT_SECRET = origSecret;
    if (origTenant !== undefined) process.env.MSTEAMS_TENANT_ID = origTenant;
  });

  it('returns void (does not throw) when metadata is missing serviceUrl', async () => {
    await expect(
      adapter.sendTypingIndicator(teamsConnection, 'session-1', {
        conversationId: 'conv-789',
      }),
    ).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns void (does not throw) when metadata is missing conversationId', async () => {
    await expect(
      adapter.sendTypingIndicator(teamsConnection, 'session-1', {
        serviceUrl: 'https://smba.trafficmanager.net/teams/',
      }),
    ).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// =============================================================================
// TELEGRAM ADAPTER -- sendTypingIndicator
// =============================================================================

describe('TelegramAdapter.sendTypingIndicator', () => {
  let adapter: TelegramAdapter;

  beforeEach(() => {
    adapter = new TelegramAdapter();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends correct HTTP request to Telegram Bot API', async () => {
    mockFetch.mockResolvedValue(okResponse());

    await adapter.sendTypingIndicator(telegramConnection, 'session-1', {
      telegramChatId: 12345,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bottest-bot-token/sendChatAction');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(options.body);
    expect(body).toEqual({
      chat_id: 12345,
      action: 'typing',
    });
  });

  it('returns void (does not throw) on API failure', async () => {
    mockFetch.mockResolvedValue(errorResponse(400, 'Bad Request'));

    await expect(
      adapter.sendTypingIndicator(telegramConnection, 'session-1', {
        telegramChatId: 12345,
      }),
    ).resolves.toBeUndefined();
  });

  it('returns void (does not throw) when credentials are missing', async () => {
    const noCredConn: ResolvedConnection = {
      ...telegramConnection,
      credentials: null,
    };

    await expect(
      adapter.sendTypingIndicator(noCredConn, 'session-1', {
        telegramChatId: 12345,
      }),
    ).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns void (does not throw) when metadata is missing telegramChatId', async () => {
    await expect(
      adapter.sendTypingIndicator(telegramConnection, 'session-1', {}),
    ).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns void (does not throw) when metadata is undefined', async () => {
    await expect(
      adapter.sendTypingIndicator(telegramConnection, 'session-1', undefined),
    ).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// =============================================================================
// LINE ADAPTER -- sendTypingIndicator
// =============================================================================

describe('LineAdapter.sendTypingIndicator', () => {
  let adapter: LineAdapter;

  beforeEach(() => {
    adapter = new LineAdapter();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends correct HTTP request to LINE loading endpoint', async () => {
    mockFetch.mockResolvedValue(okResponse());

    await adapter.sendTypingIndicator(lineConnection, 'session-1', {
      lineUserId: 'U1234567890',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.line.me/v2/bot/chat/loading/start');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer line-access-token');
    expect(options.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(options.body);
    expect(body).toEqual({
      chatId: 'U1234567890',
      loadingSeconds: 20,
    });
  });

  it('returns void when metadata has no lineUserId', async () => {
    await expect(
      adapter.sendTypingIndicator(lineConnection, 'session-1', {}),
    ).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns void for non-1:1 LINE chats even if lineUserId is present', async () => {
    await expect(
      adapter.sendTypingIndicator(lineConnection, 'session-1', {
        lineSourceType: 'group',
        lineUserId: 'U1234567890',
      }),
    ).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns void when credentials are missing', async () => {
    await expect(
      adapter.sendTypingIndicator({ ...lineConnection, credentials: null }, 'session-1', {
        lineUserId: 'U1234567890',
      }),
    ).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// =============================================================================
// SLACK ADAPTER -- no sendTypingIndicator
// =============================================================================

describe('SlackAdapter', () => {
  it('does NOT have a sendTypingIndicator method', () => {
    const adapter = new SlackAdapter();
    expect(adapter).not.toHaveProperty('sendTypingIndicator');
  });
});

// =============================================================================
// CHANNEL MANIFEST -- supportsTypingIndicator flags
// =============================================================================

describe('CHANNEL_MANIFEST supportsTypingIndicator', () => {
  const channelsWithTyping = [
    'line',
    'msteams',
    'messenger',
    'telegram',
    'sdk_websocket',
    'ag_ui',
    'web_debug',
    'web_chat',
  ];

  const channelsWithoutTyping = [
    'http_async',
    'slack',
    'whatsapp',
    'twilio_sms',
    'zendesk',
    'email',
    'voice_vxml',
    'korevg',
    'audiocodes',
    'voice_pipeline',
    'voice',
    'voice_twilio',
    'voice_livekit',
    'a2a',
    'api',
    'http',
  ];

  for (const channel of channelsWithTyping) {
    it(`${channel} has supportsTypingIndicator: true`, () => {
      expect(CHANNEL_MANIFEST[channel]).toBeDefined();
      expect(CHANNEL_MANIFEST[channel].supportsTypingIndicator).toBe(true);
    });
  }

  for (const channel of channelsWithoutTyping) {
    it(`${channel} has supportsTypingIndicator: false`, () => {
      expect(CHANNEL_MANIFEST[channel]).toBeDefined();
      expect(CHANNEL_MANIFEST[channel].supportsTypingIndicator).toBe(false);
    });
  }
});

// =============================================================================
// ServerMessages.typingStart
// =============================================================================

describe('ServerMessages.typingStart', () => {
  it('returns correct shape with type and sessionId', () => {
    const result = ServerMessages.typingStart('sess-abc');
    expect(result).toEqual({
      type: 'typing_start',
      sessionId: 'sess-abc',
    });
  });

  it('includes only type and sessionId keys', () => {
    const result = ServerMessages.typingStart('sess-xyz');
    expect(Object.keys(result)).toHaveLength(2);
    expect(Object.keys(result).sort()).toEqual(['sessionId', 'type']);
  });
});
