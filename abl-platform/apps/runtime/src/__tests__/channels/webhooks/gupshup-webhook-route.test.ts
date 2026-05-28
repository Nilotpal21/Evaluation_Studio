/**
 * Gupshup WhatsApp Webhook Route Integration Tests
 *
 * Verifies the provider-specific route POST /whatsapp/gupshup/webhook
 * correctly delegates to GupshupProvider for shouldProcess,
 * buildNormalizedMessage, and extractEventId — both pre-connection
 * and post-connection filters.
 *
 * This is the dedicated coverage for the P0 fix: the post-connection
 * filter (step 4b) must use providerHint, not the adapter default.
 */

import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS
// =============================================================================

const mockGupshupProvider = {
  providerId: 'gupshup',
  shouldProcess: vi.fn().mockReturnValue(true),
  extractExternalIdentifier: vi.fn().mockReturnValue('918888888888'),
  extractEventId: vi.fn().mockReturnValue('msg-gup-001'),
  buildNormalizedMessage: vi.fn().mockReturnValue({
    text: 'hello from gupshup',
    externalSessionKey: 'whatsapp:918888888888:919999999999',
    externalMessageId: 'msg-gup-001',
    metadata: { whatsappFrom: '919999999999', whatsappPhoneNumberId: '918888888888' },
    timestamp: new Date('2026-01-01'),
  }),
  verifyRequest: vi.fn().mockResolvedValue(true),
  sendResponse: vi.fn().mockResolvedValue({ success: true }),
  transformOutput: vi.fn().mockReturnValue({ kind: 'text', text: 'ok' }),
};

// Mock the WhatsApp adapter — must exist for the registry to return it
const mockWhatsAppAdapter = {
  channelType: 'whatsapp' as const,
  capabilities: {} as any,
  verifyRequest: vi.fn().mockResolvedValue(true),
  parseIncoming: vi.fn((p: any) => p.message),
  sendResponse: vi.fn().mockResolvedValue({ success: true }),
  // This is the trap: if shouldProcess is called on the adapter (instead of provider),
  // it would return false for Gupshup payloads (P0 bug).
  shouldProcess: vi.fn().mockReturnValue(false),
  extractExternalIdentifier: vi.fn().mockReturnValue(null),
  extractEventId: vi.fn().mockReturnValue(null),
  buildNormalizedMessage: vi.fn().mockReturnValue({
    text: '',
    externalSessionKey: '',
    externalMessageId: '',
    metadata: {},
  }),
};

const mockQueueAdd = vi.fn().mockResolvedValue({});

vi.mock('../../../channels/registry.js', () => ({
  getChannelRegistry: vi.fn(() => ({
    get: vi.fn((type: string) => (type === 'whatsapp' ? mockWhatsAppAdapter : undefined)),
  })),
}));

vi.mock('../../../channels/manifest.js', () => ({
  WEBHOOK_CAPABLE_TYPES: new Set(['slack', 'whatsapp', 'messenger', 'msteams', 'voice_twilio']),
  META_WEBHOOK_TYPES: new Set(['whatsapp', 'messenger']),
}));

vi.mock('../../../channels/adapters/whatsapp-provider.js', () => ({
  resolveWhatsAppProvider: vi.fn((id: string) => {
    if (id === 'gupshup') return mockGupshupProvider;
    throw new Error(`Unknown provider: ${id}`);
  }),
}));

const mockResolveConnection = vi.fn();
vi.mock('../../../channels/connection-resolver.js', () => ({
  resolveChannelConnection: (...args: any[]) => mockResolveConnection(...args),
}));

const mockGetInboundQueue = vi.fn();
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

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import express from 'express';

// =============================================================================
// HELPERS
// =============================================================================

const GUPSHUP_CONNECTION = {
  id: 'conn-gup-1',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  agentId: 'agent-1',
  deploymentId: null,
  environment: null,
  channelType: 'whatsapp' as const,
  externalIdentifier: '918888888888',
  credentials: { username: 'gup-user', password: 'gup-pass', webhook_secret: 'secret' },
  config: { provider: 'gupshup' },
  status: 'active',
};

const GUPSHUP_TEXT_PAYLOAD = {
  mobile: '919999999999',
  waNumber: '918888888888',
  type: 'text',
  text: 'hello from gupshup',
  name: 'Test User',
  messageId: 'msg-gup-001',
  timestamp: '1700000000',
};

async function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const webhookRouter = (await import('../../../routes/channel-webhooks.js')).default;
  app.use('/api/v1/channels', webhookRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

async function post(baseUrl: string, path: string, body: any) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Gupshup provider-specific webhook route', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    ({ baseUrl, server } = await createTestApp());
  });

  afterAll(() => {
    server?.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGupshupProvider.shouldProcess.mockReturnValue(true);
    mockGupshupProvider.extractExternalIdentifier.mockReturnValue('918888888888');
    mockGupshupProvider.extractEventId.mockReturnValue('msg-gup-001');
    mockGupshupProvider.verifyRequest.mockResolvedValue(true);
    mockGupshupProvider.buildNormalizedMessage.mockReturnValue({
      text: 'hello from gupshup',
      externalSessionKey: 'whatsapp:918888888888:919999999999',
      externalMessageId: 'msg-gup-001',
      metadata: { whatsappFrom: '919999999999', whatsappPhoneNumberId: '918888888888' },
      timestamp: new Date('2026-01-01'),
    });

    // The adapter's shouldProcess returns false — Gupshup payloads don't match Meta format.
    // If the route incorrectly delegates to the adapter, this will cause a silent drop.
    mockWhatsAppAdapter.shouldProcess.mockReturnValue(false);

    mockResolveConnection.mockResolvedValue(GUPSHUP_CONNECTION);
    mockGetInboundQueue.mockReturnValue({ add: mockQueueAdd });
    mockQueueAdd.mockResolvedValue({});
  });

  test('enqueues Gupshup text message through provider-specific route', async () => {
    const { status, body } = await post(
      baseUrl,
      '/api/v1/channels/whatsapp/gupshup/webhook',
      GUPSHUP_TEXT_PAYLOAD,
    );

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });

    // Provider's shouldProcess was called (not adapter's)
    expect(mockGupshupProvider.shouldProcess).toHaveBeenCalledWith(GUPSHUP_TEXT_PAYLOAD);
    expect(mockGupshupProvider.buildNormalizedMessage).toHaveBeenCalledWith(GUPSHUP_TEXT_PAYLOAD);
    expect(mockGupshupProvider.extractEventId).toHaveBeenCalledWith(GUPSHUP_TEXT_PAYLOAD);

    // Adapter's shouldProcess must NOT have been called
    expect(mockWhatsAppAdapter.shouldProcess).not.toHaveBeenCalled();

    // Message was enqueued
    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const jobPayload = mockQueueAdd.mock.calls[0][1];
    expect(jobPayload.channelType).toBe('whatsapp');
    expect(jobPayload.connectionId).toBe('conn-gup-1');
    expect(jobPayload.message.text).toBe('hello from gupshup');
  });

  test('P0 regression: post-connection filter uses provider, not adapter', async () => {
    // This is the exact P0 scenario:
    // - Gupshup provider says shouldProcess=true
    // - Adapter (meta_cloud default) says shouldProcess=false
    // Before the fix, the adapter's false would drop the message.
    mockGupshupProvider.shouldProcess.mockReturnValue(true);
    mockWhatsAppAdapter.shouldProcess.mockReturnValue(false);

    const { status } = await post(
      baseUrl,
      '/api/v1/channels/whatsapp/gupshup/webhook',
      GUPSHUP_TEXT_PAYLOAD,
    );

    expect(status).toBe(200);
    expect(mockQueueAdd).toHaveBeenCalledOnce();
    expect(mockWhatsAppAdapter.shouldProcess).not.toHaveBeenCalled();
  });

  test('filters when Gupshup provider shouldProcess returns false', async () => {
    mockGupshupProvider.shouldProcess.mockReturnValue(false);

    const { status, body } = await post(baseUrl, '/api/v1/channels/whatsapp/gupshup/webhook', {
      mobile: '919999999999',
      waNumber: '918888888888',
      type: 'status_update',
    });

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('returns 400 for unknown provider', async () => {
    const { status, body } = await post(
      baseUrl,
      '/api/v1/channels/whatsapp/unknown_provider/webhook',
      GUPSHUP_TEXT_PAYLOAD,
    );

    expect(status).toBe(400);
    expect(body.error).toContain('Unknown provider');
  });

  test('returns 401 when JWT verification fails', async () => {
    // handleWebhookPost calls adapter.verifyRequest(), which delegates to
    // getProvider(connection) internally. In this test the adapter is fully mocked,
    // so we mock the adapter's verifyRequest to simulate a failure.
    mockWhatsAppAdapter.verifyRequest.mockResolvedValue(false);

    const { status, body } = await post(
      baseUrl,
      '/api/v1/channels/whatsapp/gupshup/webhook',
      GUPSHUP_TEXT_PAYLOAD,
    );

    expect(status).toBe(401);
    expect(body.error).toContain('Invalid signature');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('returns 404 when no connection found for waNumber', async () => {
    mockResolveConnection.mockResolvedValue(null);

    const { status, body } = await post(
      baseUrl,
      '/api/v1/channels/whatsapp/gupshup/webhook',
      GUPSHUP_TEXT_PAYLOAD,
    );

    expect(status).toBe(404);
    expect(body.error).toContain('Channel not configured');
  });

  test('returns 400 when waNumber missing from payload', async () => {
    mockGupshupProvider.extractExternalIdentifier.mockReturnValue(null);

    const { status, body } = await post(baseUrl, '/api/v1/channels/whatsapp/gupshup/webhook', {
      mobile: '919999999999',
      type: 'text',
      text: 'hi',
    });

    expect(status).toBe(400);
    expect(body.error).toContain('Missing external identifier');
  });
});
