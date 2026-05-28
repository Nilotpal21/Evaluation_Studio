import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'stream';

const mockAdapter = {
  channelType: 'twilio_sms' as const,
  capabilities: {
    supportsAsync: true,
    supportsStreaming: false,
    supportsMedia: true,
    supportsThreading: false,
  },
  verifyRequest: vi.fn().mockResolvedValue(true),
  parseIncoming: vi.fn((payload: any) => payload.message),
  sendResponse: vi.fn(),
  shouldProcess: vi.fn().mockReturnValue(true),
  handleVerificationChallenge: vi.fn().mockReturnValue(null),
  extractExternalIdentifier: vi.fn().mockReturnValue('+15559876543'),
  extractEventId: vi.fn().mockReturnValue('SM1234567890abcdef1234567890abcdef'),
  buildNormalizedMessage: vi.fn().mockReturnValue({
    externalMessageId: 'SM1234567890abcdef1234567890abcdef',
    externalSessionKey: 'twilio_sms:+15559876543:+15551234567',
    text: 'Hello from SMS',
    metadata: {
      twilioFrom: '+15551234567',
      twilioTo: '+15559876543',
      twilioAccountSid: 'AC1234567890abcdef1234567890abcdef',
    },
    timestamp: new Date('2026-03-06T00:00:00.000Z'),
  }),
  transformOutput: vi.fn(),
};

const mockQueueAdd = vi.fn().mockResolvedValue({});
const mockResolveConnection = vi.fn();
const mockGetInboundQueue = vi.fn();

vi.mock('../../../channels/registry.js', () => ({
  getChannelRegistry: vi.fn(() => ({
    get: vi.fn((type: string) => (type === 'twilio_sms' ? mockAdapter : undefined)),
  })),
}));

vi.mock('../../../channels/manifest.js', () => ({
  WEBHOOK_CAPABLE_TYPES: new Set(['twilio_sms']),
  META_WEBHOOK_TYPES: new Set(),
}));

vi.mock('../../../channels/connection-resolver.js', () => ({
  resolveChannelConnection: (...args: any[]) => mockResolveConnection(...args),
}));

vi.mock('../../../services/queues/channel-queues.js', () => ({
  getInboundQueue: () => mockGetInboundQueue(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import channelWebhooksRouter from '../../../routes/channel-webhooks.js';

const MOCK_CONNECTION = {
  id: 'conn-twilio-1',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  agentId: 'agent-1',
  deploymentId: null,
  environment: null,
  channelType: 'twilio_sms' as const,
  externalIdentifier: '+15559876543',
  credentials: {
    account_sid: 'AC1234567890abcdef1234567890abcdef',
    auth_token: 'test_auth_token_secret_123',
  },
  config: {},
  status: 'active',
};

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    set(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return this.headers[name.toLowerCase()];
    },
    removeHeader(name: string) {
      delete this.headers[name.toLowerCase()];
    },
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code;
      if (headers) {
        for (const [name, value] of Object.entries(headers)) {
          this.headers[name.toLowerCase()] = value;
        }
      }
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
    end(payload?: unknown) {
      if (payload !== undefined) this.body = payload;
      return this;
    },
  };
}

function createFormRequest(formBody: string) {
  const req = Object.assign(new PassThrough(), {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(formBody)),
      host: 'evil.attacker.test',
      'x-twilio-signature': 'twilio-signature-123',
      connection: 'close',
    } as Record<string, string>,
    method: 'POST',
    url: '/twilio_sms/webhook/%2B15559876543',
    originalUrl: '/api/v1/channels/twilio_sms/webhook/%2B15559876543',
    protocol: 'http',
    params: {
      channelType: 'twilio_sms',
      connectionIdentifier: '%2B15559876543',
    },
    get(name: string) {
      return this.headers[name.toLowerCase()];
    },
  });

  return req;
}

function getUrlencodedMiddleware() {
  const layer = channelWebhooksRouter.stack.find((entry: any) => !entry.route);
  return layer?.handle as (req: any, res: any, next: (err?: unknown) => void) => void;
}

function getExplicitPostHandler() {
  const layer = channelWebhooksRouter.stack.find(
    (entry: any) =>
      entry.route?.path === '/:channelType/webhook/:connectionIdentifier' &&
      entry.route?.methods?.post,
  );
  return layer?.route?.stack?.[0]?.handle as (
    req: any,
    res: any,
    next: (err?: unknown) => void,
  ) => Promise<void>;
}

describe('Twilio webhook route integration', () => {
  const originalRuntimePublicBaseUrl = process.env.RUNTIME_PUBLIC_BASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RUNTIME_PUBLIC_BASE_URL = 'https://runtime.example.com';
    mockAdapter.shouldProcess.mockReturnValue(true);
    mockAdapter.verifyRequest.mockResolvedValue(true);
    mockAdapter.extractEventId.mockReturnValue('SM1234567890abcdef1234567890abcdef');
    mockAdapter.buildNormalizedMessage.mockReturnValue({
      externalMessageId: 'SM1234567890abcdef1234567890abcdef',
      externalSessionKey: 'twilio_sms:+15559876543:+15551234567',
      text: 'Hello from SMS',
      metadata: {
        twilioFrom: '+15551234567',
        twilioTo: '+15559876543',
        twilioAccountSid: 'AC1234567890abcdef1234567890abcdef',
      },
      timestamp: new Date('2026-03-06T00:00:00.000Z'),
    });
    mockResolveConnection.mockResolvedValue(MOCK_CONNECTION);
    mockGetInboundQueue.mockReturnValue({ add: mockQueueAdd });
    mockQueueAdd.mockResolvedValue({});
  });

  afterEach(() => {
    if (originalRuntimePublicBaseUrl === undefined) {
      delete process.env.RUNTIME_PUBLIC_BASE_URL;
    } else {
      process.env.RUNTIME_PUBLIC_BASE_URL = originalRuntimePublicBaseUrl;
    }
  });

  it('parses form-encoded Twilio payloads, verifies against configured public URL, and returns empty TwiML', async () => {
    const form = new URLSearchParams({
      MessageSid: 'SM1234567890abcdef1234567890abcdef',
      AccountSid: 'AC1234567890abcdef1234567890abcdef',
      From: '+15551234567',
      To: '+15559876543',
      Body: 'Hello from SMS',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM123/Media/ME123',
      MediaContentType0: 'image/jpeg',
    });
    const req = createFormRequest(form.toString());
    const res = createMockResponse();

    const urlencodedMiddleware = getUrlencodedMiddleware();
    const explicitPostHandler = getExplicitPostHandler();

    expect(typeof urlencodedMiddleware).toBe('function');
    expect(typeof explicitPostHandler).toBe('function');

    const middlewareDone = new Promise<void>((resolve, reject) => {
      urlencodedMiddleware(req as any, res as any, (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
    req.end(form.toString());
    await middlewareDone;

    await explicitPostHandler(req as any, res as any, (err?: unknown) => {
      if (err) throw err;
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    expect(mockAdapter.verifyRequest).toHaveBeenCalledTimes(1);
    const [headersArg, bodyArg, rawBodyArg, connectionArg, webhookUrlArg] =
      mockAdapter.verifyRequest.mock.calls[0];

    expect(headersArg['x-twilio-signature']).toBe('twilio-signature-123');
    expect(bodyArg).toEqual({
      MessageSid: 'SM1234567890abcdef1234567890abcdef',
      AccountSid: 'AC1234567890abcdef1234567890abcdef',
      From: '+15551234567',
      To: '+15559876543',
      Body: 'Hello from SMS',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM123/Media/ME123',
      MediaContentType0: 'image/jpeg',
    });
    expect(Buffer.isBuffer(rawBodyArg)).toBe(true);
    expect(connectionArg).toEqual(MOCK_CONNECTION);
    expect(webhookUrlArg).toBe(
      'https://runtime.example.com/api/v1/channels/twilio_sms/webhook/%2B15559876543',
    );

    expect(mockAdapter.buildNormalizedMessage).toHaveBeenCalledWith(bodyArg, MOCK_CONNECTION);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [jobName, jobPayload] = mockQueueAdd.mock.calls[0];
    expect(jobName).toBe('process-message');
    expect(jobPayload.channelType).toBe('twilio_sms');
    expect(jobPayload.idempotencyKey).toBe('SM1234567890abcdef1234567890abcdef');
    expect(jobPayload.message.externalSessionKey).toBe('twilio_sms:+15559876543:+15551234567');
  });
});
