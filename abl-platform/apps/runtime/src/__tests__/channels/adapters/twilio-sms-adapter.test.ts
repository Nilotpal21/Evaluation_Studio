/**
 * Twilio SMS Adapter Tests
 *
 * Tests shouldProcess(), extractEventId(), buildNormalizedMessage(),
 * verifyRequest() (HMAC-SHA1 with URL-based validation), and
 * sendResponse() (Twilio REST API integration).
 */

import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TwilioSmsAdapter } from '../../../channels/adapters/twilio-sms-adapter.js';
import type { ResolvedConnection } from '../../../channels/types.js';

const DELIVERY_FAILED_CUSTOMER_MESSAGE =
  "I'm having trouble delivering that response. Please try again.";
const DELIVERY_CONFIGURATION_CUSTOMER_MESSAGE =
  'This channel is not fully configured for response delivery. Please contact support.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTwilioBody(overrides?: Record<string, string>): Record<string, string> {
  return {
    MessageSid: 'SM1234567890abcdef1234567890abcdef',
    AccountSid: 'AC1234567890abcdef1234567890abcdef',
    From: '+15551234567',
    To: '+15559876543',
    Body: 'Hello from SMS',
    NumMedia: '0',
    NumSegments: '1',
    ...overrides,
  };
}

/**
 * Compute Twilio HMAC-SHA1 signature.
 * Algorithm: HMAC-SHA1(authToken, webhookUrl + sortedKeys.map(k => k + params[k]).join(''))
 */
function signTwilio(authToken: string, url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  const data = url + sortedKeys.map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', authToken).update(data).digest('base64');
}

function makeConnection(overrides?: Partial<ResolvedConnection>): ResolvedConnection {
  return {
    id: 'conn-twilio-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    channelType: 'twilio_sms',
    externalIdentifier: '+15559876543',
    credentials: {
      account_sid: 'AC1234567890abcdef1234567890abcdef',
      auth_token: 'test_auth_token_secret_123',
    },
    config: {
      from_number: '+15559876543',
    },
    status: 'active',
    ...overrides,
  };
}

const WEBHOOK_URL = 'https://example.com/api/v1/channels/twilio_sms/webhook/+15559876543';
const AUTH_TOKEN = 'test_auth_token_secret_123';

// ---------------------------------------------------------------------------
// shouldProcess
// ---------------------------------------------------------------------------

describe('TwilioSmsAdapter.shouldProcess', () => {
  const adapter = new TwilioSmsAdapter();

  it('returns true for text message (Body present)', () => {
    const body = makeTwilioBody();
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns true for MMS (NumMedia > 0)', () => {
    const body = makeTwilioBody({
      Body: '',
      NumMedia: '2',
      MediaUrl0: 'https://api.twilio.com/image0.jpg',
      MediaContentType0: 'image/jpeg',
      MediaUrl1: 'https://api.twilio.com/image1.png',
      MediaContentType1: 'image/png',
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('returns false for empty body and no media', () => {
    const body = makeTwilioBody({ Body: '', NumMedia: '0' });
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns false for missing MessageSid', () => {
    const body = makeTwilioBody();
    delete (body as any).MessageSid;
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns false for whitespace-only Body', () => {
    const body = makeTwilioBody({ Body: '   ', NumMedia: '0' });
    expect(adapter.shouldProcess(body)).toBe(false);
  });

  it('returns true for MMS with empty body but media attached', () => {
    const body = makeTwilioBody({
      Body: '',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media.jpg',
      MediaContentType0: 'image/jpeg',
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractEventId
// ---------------------------------------------------------------------------

describe('TwilioSmsAdapter.extractEventId', () => {
  const adapter = new TwilioSmsAdapter();

  it('returns MessageSid', () => {
    const body = makeTwilioBody();
    expect(adapter.extractEventId(body)).toBe('SM1234567890abcdef1234567890abcdef');
  });

  it('returns null for empty/missing MessageSid', () => {
    expect(adapter.extractEventId({})).toBeNull();
    expect(adapter.extractEventId({ MessageSid: '' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildNormalizedMessage
// ---------------------------------------------------------------------------

describe('TwilioSmsAdapter.buildNormalizedMessage', () => {
  const adapter = new TwilioSmsAdapter();

  it('normalizes standard text SMS', () => {
    const body = makeTwilioBody();
    const msg = adapter.buildNormalizedMessage(body);

    expect(msg.externalMessageId).toBe('SM1234567890abcdef1234567890abcdef');
    expect(msg.externalSessionKey).toBe('twilio_sms:+15559876543:+15551234567');
    expect(msg.text).toBe('Hello from SMS');
    expect(msg.metadata?.twilioFrom).toBe('+15551234567');
    expect(msg.metadata?.twilioTo).toBe('+15559876543');
    expect(msg.metadata?.twilioAccountSid).toBe('AC1234567890abcdef1234567890abcdef');
    expect(msg.timestamp).toBeInstanceOf(Date);
  });

  it('preserves inbound text verbatim even if it matches Twilio trial banner text', () => {
    const body = makeTwilioBody({
      Body: 'Sent from your Twilio trial account - Hello world',
    });
    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('Sent from your Twilio trial account - Hello world');
  });

  it('handles MMS media references', () => {
    const body = makeTwilioBody({
      Body: 'Check this out',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM456/Media/ME789',
      MediaContentType0: 'image/jpeg',
    });
    const msg = adapter.buildNormalizedMessage(body);

    expect(msg.text).toBe('Check this out');
    const mediaRefs = msg.metadata?.twilioMediaReferences as Array<{
      url: string;
      contentType: string;
      index: number;
    }>;
    expect(mediaRefs).toHaveLength(1);
    expect(mediaRefs[0].url).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM456/Media/ME789',
    );
    expect(mediaRefs[0].contentType).toBe('image/jpeg');
    expect(mediaRefs[0].index).toBe(0);
  });

  it('handles multiple media items', () => {
    const body = makeTwilioBody({
      Body: '',
      NumMedia: '3',
      MediaUrl0: 'https://api.twilio.com/media/0',
      MediaContentType0: 'image/jpeg',
      MediaUrl1: 'https://api.twilio.com/media/1',
      MediaContentType1: 'image/png',
      MediaUrl2: 'https://api.twilio.com/media/2',
      MediaContentType2: 'video/mp4',
    });
    const msg = adapter.buildNormalizedMessage(body);

    const mediaRefs = msg.metadata?.twilioMediaReferences as Array<{
      url: string;
      contentType: string;
      index: number;
    }>;
    expect(mediaRefs).toHaveLength(3);
    expect(mediaRefs[0].contentType).toBe('image/jpeg');
    expect(mediaRefs[1].contentType).toBe('image/png');
    expect(mediaRefs[2].contentType).toBe('video/mp4');
  });

  it('session key format is twilio_sms:{To}:{From}', () => {
    const body = makeTwilioBody({ To: '+18005551234', From: '+19995550000' });
    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.externalSessionKey).toBe('twilio_sms:+18005551234:+19995550000');
  });
});

// ---------------------------------------------------------------------------
// verifyRequest
// ---------------------------------------------------------------------------

describe('TwilioSmsAdapter.verifyRequest', () => {
  const adapter = new TwilioSmsAdapter();

  it('accepts valid HMAC-SHA1 signature', async () => {
    const body = makeTwilioBody();
    const signature = signTwilio(AUTH_TOKEN, WEBHOOK_URL, body);
    const connection = makeConnection();

    const result = await adapter.verifyRequest(
      { 'x-twilio-signature': signature },
      body,
      undefined,
      connection,
      WEBHOOK_URL,
    );
    expect(result).toBe(true);
  });

  it('rejects invalid signature', async () => {
    const body = makeTwilioBody();
    const connection = makeConnection();

    const result = await adapter.verifyRequest(
      { 'x-twilio-signature': 'dGhpcyBpcyBpbnZhbGlk' },
      body,
      undefined,
      connection,
      WEBHOOK_URL,
    );
    expect(result).toBe(false);
  });

  it('rejects missing X-Twilio-Signature header', async () => {
    const body = makeTwilioBody();
    const connection = makeConnection();

    const result = await adapter.verifyRequest({}, body, undefined, connection, WEBHOOK_URL);
    expect(result).toBe(false);
  });

  it('rejects missing auth_token in credentials', async () => {
    const body = makeTwilioBody();
    const connection = makeConnection({ credentials: {} });

    const result = await adapter.verifyRequest(
      { 'x-twilio-signature': 'anything' },
      body,
      undefined,
      connection,
      WEBHOOK_URL,
    );
    expect(result).toBe(false);
  });

  it('rejects missing webhookUrl', async () => {
    const body = makeTwilioBody();
    const connection = makeConnection();
    const signature = signTwilio(AUTH_TOKEN, '', body);

    const result = await adapter.verifyRequest(
      { 'x-twilio-signature': signature },
      body,
      undefined,
      connection,
      undefined,
    );
    expect(result).toBe(false);
  });

  it('handles signature comparison with different lengths gracefully', async () => {
    const body = makeTwilioBody();
    const connection = makeConnection();

    const result = await adapter.verifyRequest(
      { 'x-twilio-signature': 'short' },
      body,
      undefined,
      connection,
      WEBHOOK_URL,
    );
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendResponse
// ---------------------------------------------------------------------------

describe('TwilioSmsAdapter.sendResponse', () => {
  const adapter = new TwilioSmsAdapter();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends to correct Twilio API URL with Basic Auth', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        sid: 'SM_response_123',
        status: 'queued',
      }),
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as any);

    const connection = makeConnection();
    const result = await adapter.sendResponse(
      {
        sessionId: 'session-1',
        text: 'Hi there!',
        eventType: 'agent.response',
        metadata: { twilioFrom: '+15551234567' },
      },
      connection,
    );

    expect(result.success).toBe(true);
    expect(result.deliveryId).toBe('SM_response_123');

    // Verify fetch was called correctly
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    const options = fetchCall[1] as RequestInit;

    // Correct API URL
    expect(url).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/AC1234567890abcdef1234567890abcdef/Messages.json',
    );

    // Basic Auth header
    const expectedAuth = Buffer.from(
      'AC1234567890abcdef1234567890abcdef:test_auth_token_secret_123',
    ).toString('base64');
    expect(options.headers).toEqual(
      expect.objectContaining({
        Authorization: `Basic ${expectedAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      }),
    );

    // Form-encoded body
    const bodyStr = options.body as string;
    const params = new URLSearchParams(bodyStr);
    expect(params.get('To')).toBe('+15551234567');
    expect(params.get('Body')).toBe('Hi there!');
  });

  it('prefers MessagingServiceSid from credentials', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ sid: 'SM_msgsvc_123', status: 'queued' }),
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as any);

    const connection = makeConnection({
      credentials: {
        account_sid: 'AC1234567890abcdef1234567890abcdef',
        auth_token: AUTH_TOKEN,
        messaging_service_sid: 'MG1234567890abcdef',
      },
    });

    await adapter.sendResponse(
      {
        sessionId: 'session-1',
        text: 'Hello',
        eventType: 'agent.response',
        metadata: { twilioFrom: '+15551234567' },
      },
      connection,
    );

    const bodyStr = vi.mocked(fetch).mock.calls[0][1]?.body as string;
    const params = new URLSearchParams(bodyStr);
    expect(params.get('MessagingServiceSid')).toBe('MG1234567890abcdef');
    expect(params.has('From')).toBe(false);
  });

  it('falls back to from_number from config', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ sid: 'SM_from_123', status: 'queued' }),
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as any);

    const connection = makeConnection({
      credentials: {
        account_sid: 'AC1234567890abcdef1234567890abcdef',
        auth_token: AUTH_TOKEN,
      },
      config: { from_number: '+18005550000' },
    });

    await adapter.sendResponse(
      {
        sessionId: 'session-1',
        text: 'Hello',
        eventType: 'agent.response',
        metadata: { twilioFrom: '+15551234567' },
      },
      connection,
    );

    const bodyStr = vi.mocked(fetch).mock.calls[0][1]?.body as string;
    const params = new URLSearchParams(bodyStr);
    expect(params.get('From')).toBe('+18005550000');
  });

  it('falls back to twilioTo from metadata when no config from_number', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ sid: 'SM_fallback_123', status: 'queued' }),
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as any);

    const connection = makeConnection({
      credentials: {
        account_sid: 'AC1234567890abcdef1234567890abcdef',
        auth_token: AUTH_TOKEN,
      },
      config: {},
    });

    await adapter.sendResponse(
      {
        sessionId: 'session-1',
        text: 'Hello',
        eventType: 'agent.response',
        metadata: { twilioFrom: '+15551234567', twilioTo: '+15559876543' },
      },
      connection,
    );

    const bodyStr = vi.mocked(fetch).mock.calls[0][1]?.body as string;
    const params = new URLSearchParams(bodyStr);
    expect(params.get('From')).toBe('+15559876543');
  });

  it('returns error for missing credentials', async () => {
    const connection = makeConnection({ credentials: null });
    const result = await adapter.sendResponse(
      {
        sessionId: 'session-1',
        text: 'Hello',
        eventType: 'agent.response',
        metadata: { twilioFrom: '+15551234567' },
      },
      connection,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(DELIVERY_CONFIGURATION_CUSTOMER_MESSAGE);
    expect(result.metadata?.channelDiagnostic).toMatchObject({
      category: 'configuration',
      code: 'CHANNEL_DELIVERY_CONFIGURATION',
      provider: 'twilio',
    });
  });

  it('returns error for missing recipient', async () => {
    const connection = makeConnection();
    const result = await adapter.sendResponse(
      {
        sessionId: 'session-1',
        text: 'Hello',
        eventType: 'agent.response',
        metadata: {},
      },
      connection,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(DELIVERY_FAILED_CUSTOMER_MESSAGE);
    expect(result.metadata?.channelDiagnostic).toMatchObject({
      category: 'metadata',
      code: 'CHANNEL_DELIVERY_METADATA',
      provider: 'twilio',
    });
  });

  it('returns error when no From or MessagingServiceSid available', async () => {
    const connection = makeConnection({
      credentials: {
        account_sid: 'AC1234567890abcdef1234567890abcdef',
        auth_token: AUTH_TOKEN,
      },
      config: {},
    });

    const result = await adapter.sendResponse(
      {
        sessionId: 'session-1',
        text: 'Hello',
        eventType: 'agent.response',
        metadata: { twilioFrom: '+15551234567' },
      },
      connection,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(DELIVERY_CONFIGURATION_CUSTOMER_MESSAGE);
    expect(result.metadata?.channelDiagnostic).toMatchObject({
      category: 'configuration',
      code: 'CHANNEL_DELIVERY_CONFIGURATION',
      provider: 'twilio',
    });
    expect(result.metadata?.channelDiagnostic).toMatchObject({
      message: expect.stringContaining('MessagingServiceSid'),
    });
  });

  it('handles Twilio API error response', async () => {
    const mockResponse = {
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('{"code":21211,"message":"Invalid To phone number"}'),
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as any);

    const connection = makeConnection();
    const result = await adapter.sendResponse(
      {
        sessionId: 'session-1',
        text: 'Hello',
        eventType: 'agent.response',
        metadata: { twilioFrom: '+15551234567' },
      },
      connection,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(DELIVERY_FAILED_CUSTOMER_MESSAGE);
    expect(result.metadata?.channelDiagnostic).toMatchObject({
      category: 'provider',
      code: 'CHANNEL_PROVIDER_REJECTED',
      httpStatus: 400,
      provider: 'twilio',
    });
  });

  it('handles fetch network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network timeout'));

    const connection = makeConnection();
    const result = await adapter.sendResponse(
      {
        sessionId: 'session-1',
        text: 'Hello',
        eventType: 'agent.response',
        metadata: { twilioFrom: '+15551234567' },
      },
      connection,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(DELIVERY_FAILED_CUSTOMER_MESSAGE);
    expect(result.metadata?.channelDiagnostic).toMatchObject({
      category: 'network',
      code: 'CHANNEL_DELIVERY_FAILED',
      provider: 'twilio',
    });
  });
});

// ---------------------------------------------------------------------------
// extractExternalIdentifier
// ---------------------------------------------------------------------------

describe('TwilioSmsAdapter.extractExternalIdentifier', () => {
  const adapter = new TwilioSmsAdapter();

  it('returns To number from body', () => {
    const body = makeTwilioBody({ To: '+18005551234' });
    expect(adapter.extractExternalIdentifier(body)).toBe('+18005551234');
  });

  it('returns null for missing To', () => {
    expect(adapter.extractExternalIdentifier({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseIncoming
// ---------------------------------------------------------------------------

describe('TwilioSmsAdapter.parseIncoming', () => {
  const adapter = new TwilioSmsAdapter();

  it('returns payload.message', () => {
    const message = {
      externalMessageId: 'SM123',
      externalSessionKey: 'twilio_sms:+1:+2',
      text: 'Hi',
      timestamp: new Date(),
    };
    const result = adapter.parseIncoming({
      connectionId: 'conn-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'twilio_sms',
      message,
      subscriptionId: '',
      idempotencyKey: 'key-1',
    });
    expect(result).toBe(message);
  });
});

// ---------------------------------------------------------------------------
// transformOutput
// ---------------------------------------------------------------------------

describe('TwilioSmsAdapter.transformOutput', () => {
  const adapter = new TwilioSmsAdapter();

  it('returns text-only output', () => {
    const result = adapter.transformOutput('Hello SMS');
    expect(result).toEqual({ kind: 'text', text: 'Hello SMS' });
  });
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

describe('TwilioSmsAdapter capabilities', () => {
  const adapter = new TwilioSmsAdapter();

  it('has correct channelType', () => {
    expect(adapter.channelType).toBe('twilio_sms');
  });

  it('has correct capabilities', () => {
    expect(adapter.capabilities).toEqual({
      supportsAsync: true,
      supportsStreaming: false,
      supportsMedia: true,
      supportsThreading: false,
    });
  });
});
