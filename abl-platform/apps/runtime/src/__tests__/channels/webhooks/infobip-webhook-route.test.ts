/**
 * Infobip Provider Webhook Route Tests
 *
 * Tests the provider-specific webhook routes:
 *   POST /:channelType/:provider/webhook           — identifier from body
 *   POST /:channelType/:provider/webhook/:id       — identifier from URL
 *
 * Covers:
 *   - Infobip route: happy path (extract identifier from body, enqueue)
 *   - Infobip route: shouldProcess filters non-processable messages
 *   - Infobip route: missing identifier → 400
 *   - Infobip route: unknown provider → 400
 *   - Infobip route: non-whatsapp channel type → 400
 *   - Infobip route: provider-specific message normalization
 *   - Infobip explicit route: identifier from URL
 *   - Infobip route: connection not found → 404
 */

import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS — declared before imports that pull them in
// =============================================================================

// Mock the WhatsApp adapter (used for generic whatsapp routes, not provider routes)
const mockWhatsAppAdapter = {
  channelType: 'whatsapp' as const,
  capabilities: {} as any,
  verifyRequest: vi.fn().mockResolvedValue(true),
  shouldProcess: vi.fn().mockReturnValue(true),
  handleVerificationChallenge: vi.fn().mockReturnValue(null),
  extractExternalIdentifier: vi.fn().mockReturnValue('+15551234567'),
  extractEventId: vi.fn().mockReturnValue('wa-evt-1'),
  buildNormalizedMessage: vi.fn().mockReturnValue({
    text: 'hello',
    externalSessionKey: 'whatsapp:+15551234567:+447415774332',
    externalMessageId: 'msg-001',
    metadata: {},
  }),
};

const mockRegistryGet = vi.fn((type: string) =>
  type === 'whatsapp' ? mockWhatsAppAdapter : undefined,
);
const mockGetChannelRegistry = vi.fn(() => ({
  get: mockRegistryGet,
}));

vi.mock('../../../channels/registry.js', () => ({
  getChannelRegistry: (...args: unknown[]) => mockGetChannelRegistry(...args),
}));

vi.mock('../../../channels/manifest.js', () => ({
  WEBHOOK_CAPABLE_TYPES: new Set(['slack', 'whatsapp', 'messenger', 'msteams']),
  META_WEBHOOK_TYPES: new Set(['whatsapp', 'messenger']),
}));

// Mock the WhatsApp provider (Infobip)
const mockInfobipProvider = {
  providerId: 'infobip',
  extractExternalIdentifier: vi.fn().mockReturnValue('+447415774332'),
  extractEventId: vi.fn().mockReturnValue('infobip-msg-001'),
  shouldProcess: vi.fn().mockReturnValue(true),
  buildNormalizedMessage: vi.fn().mockReturnValue({
    text: 'hello from infobip',
    externalSessionKey: 'whatsapp:+447415774332:+491234567890',
    externalMessageId: 'infobip-msg-001',
    metadata: { whatsappFrom: '+491234567890', whatsappPhoneNumberId: '+447415774332' },
    timestamp: new Date('2024-01-01T00:00:00Z'),
  }),
  verifyRequest: vi.fn().mockResolvedValue(true),
};

vi.mock('../../../channels/adapters/whatsapp-provider.js', () => ({
  resolveWhatsAppProvider: vi.fn((providerId?: string) => {
    if (providerId === 'infobip') return mockInfobipProvider;
    if (providerId === 'meta_cloud' || !providerId) return mockWhatsAppAdapter;
    throw new Error(`Unknown WhatsApp provider: ${providerId}`);
  }),
}));

const mockResolveConnection = vi.fn();
vi.mock('../../../channels/connection-resolver.js', () => ({
  resolveChannelConnection: (...args: any[]) => mockResolveConnection(...args),
}));

const mockQueueAdd = vi.fn().mockResolvedValue({});
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

const INFOBIP_CONNECTION = {
  id: 'conn-infobip-1',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  agentId: 'agent-1',
  deploymentId: null,
  environment: null,
  channelType: 'whatsapp' as const,
  externalIdentifier: '+447415774332',
  credentials: { base_url: 'https://test.api.infobip.com', api_key: 'test-key' },
  config: { provider: 'infobip', authType: 'api_key' },
  status: 'active',
};

const INFOBIP_INBOUND_PAYLOAD = {
  results: [
    {
      from: '+491234567890',
      to: '+447415774332',
      integrationType: 'WHATSAPP',
      receivedAt: '2024-01-01T00:00:00.000+0000',
      messageId: 'infobip-msg-001',
      message: { type: 'TEXT', text: 'hello from infobip' },
      contact: { name: 'Test User' },
    },
  ],
  messageCount: 1,
  pendingMessageCount: 0,
};

async function createTestApp() {
  const app = express();
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

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

describe('Infobip provider webhook routes', () => {
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
    // Defaults for happy path
    mockInfobipProvider.shouldProcess.mockReturnValue(true);
    mockInfobipProvider.extractExternalIdentifier.mockReturnValue('+447415774332');
    mockInfobipProvider.extractEventId.mockReturnValue('infobip-msg-001');
    mockInfobipProvider.verifyRequest.mockResolvedValue(true);
    mockInfobipProvider.buildNormalizedMessage.mockReturnValue({
      text: 'hello from infobip',
      externalSessionKey: 'whatsapp:+447415774332:+491234567890',
      externalMessageId: 'infobip-msg-001',
      metadata: { whatsappFrom: '+491234567890', whatsappPhoneNumberId: '+447415774332' },
      timestamp: new Date('2024-01-01T00:00:00Z'),
    });
    mockResolveConnection.mockResolvedValue(INFOBIP_CONNECTION);
    mockGetInboundQueue.mockReturnValue({ add: mockQueueAdd });
    mockQueueAdd.mockResolvedValue({});
  });

  // ---------------------------------------------------------------------------
  // POST /whatsapp/infobip/webhook (body-based identifier)
  // ---------------------------------------------------------------------------
  describe('POST /whatsapp/infobip/webhook (provider route, body-based)', () => {
    test('extracts identifier via Infobip provider and enqueues', async () => {
      const { status, body } = await post(
        baseUrl,
        '/api/v1/channels/whatsapp/infobip/webhook',
        INFOBIP_INBOUND_PAYLOAD,
      );

      expect(status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(mockInfobipProvider.extractExternalIdentifier).toHaveBeenCalledWith(
        INFOBIP_INBOUND_PAYLOAD,
      );
      expect(mockGetChannelRegistry).toHaveBeenCalled();
      expect(mockResolveConnection).toHaveBeenCalledWith('whatsapp', '+447415774332');
      expect(mockQueueAdd).toHaveBeenCalledOnce();
    });

    test('uses Infobip provider for shouldProcess check', async () => {
      mockInfobipProvider.shouldProcess.mockReturnValue(false);

      const { status, body } = await post(
        baseUrl,
        '/api/v1/channels/whatsapp/infobip/webhook',
        INFOBIP_INBOUND_PAYLOAD,
      );

      expect(status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(mockInfobipProvider.shouldProcess).toHaveBeenCalledWith(INFOBIP_INBOUND_PAYLOAD);
      // Should NOT enqueue when shouldProcess returns false
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    test('uses Infobip provider for message normalization', async () => {
      await post(baseUrl, '/api/v1/channels/whatsapp/infobip/webhook', INFOBIP_INBOUND_PAYLOAD);

      expect(mockInfobipProvider.buildNormalizedMessage).toHaveBeenCalledWith(
        INFOBIP_INBOUND_PAYLOAD,
      );
    });

    test('uses Infobip provider for event ID extraction', async () => {
      await post(baseUrl, '/api/v1/channels/whatsapp/infobip/webhook', INFOBIP_INBOUND_PAYLOAD);

      expect(mockInfobipProvider.extractEventId).toHaveBeenCalledWith(INFOBIP_INBOUND_PAYLOAD);
    });

    test('returns 400 when identifier cannot be extracted', async () => {
      mockInfobipProvider.extractExternalIdentifier.mockReturnValue(null);

      const { status, body } = await post(baseUrl, '/api/v1/channels/whatsapp/infobip/webhook', {
        results: [],
      });

      expect(status).toBe(400);
      expect(body.error).toContain('Missing external identifier');
    });

    test('returns 400 for unknown provider', async () => {
      const { status, body } = await post(
        baseUrl,
        '/api/v1/channels/whatsapp/unknown_bsp/webhook',
        INFOBIP_INBOUND_PAYLOAD,
      );

      expect(status).toBe(400);
      expect(body.error).toContain('Unknown provider');
    });

    test('returns 400 for non-whatsapp channel type with provider', async () => {
      const { status, body } = await post(
        baseUrl,
        '/api/v1/channels/slack/infobip/webhook',
        INFOBIP_INBOUND_PAYLOAD,
      );

      expect(status).toBe(400);
      expect(body.error).toContain('Provider routing not supported');
    });

    test('returns 404 when connection not found', async () => {
      mockResolveConnection.mockResolvedValue(null);

      const { status, body } = await post(
        baseUrl,
        '/api/v1/channels/whatsapp/infobip/webhook',
        INFOBIP_INBOUND_PAYLOAD,
      );

      expect(status).toBe(404);
      expect(body.error).toContain('Channel not configured');
    });

    test('returns 503 when queue is unavailable', async () => {
      mockGetInboundQueue.mockReturnValue(null);

      const { status, body } = await post(
        baseUrl,
        '/api/v1/channels/whatsapp/infobip/webhook',
        INFOBIP_INBOUND_PAYLOAD,
      );

      expect(status).toBe(503);
      expect(body.error).toContain('Queue unavailable');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /whatsapp/infobip/webhook/:connectionIdentifier (URL-based identifier)
  // ---------------------------------------------------------------------------
  describe('POST /whatsapp/infobip/webhook/:identifier (provider route, URL-based)', () => {
    test('uses URL identifier and enqueues', async () => {
      const { status, body } = await post(
        baseUrl,
        '/api/v1/channels/whatsapp/infobip/webhook/%2B447415774332',
        INFOBIP_INBOUND_PAYLOAD,
      );

      expect(status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(mockGetChannelRegistry).toHaveBeenCalled();
      // Should use URL identifier, not extract from body
      expect(mockResolveConnection).toHaveBeenCalledWith('whatsapp', '+447415774332');
      expect(mockQueueAdd).toHaveBeenCalledOnce();
    });

    test('returns 400 for unknown provider in URL route', async () => {
      const { status, body } = await post(
        baseUrl,
        '/api/v1/channels/whatsapp/unknown_bsp/webhook/%2B447415774332',
        INFOBIP_INBOUND_PAYLOAD,
      );

      expect(status).toBe(400);
      expect(body.error).toContain('Unknown provider');
    });

    test('returns 400 for non-whatsapp channel type in URL route', async () => {
      const { status, body } = await post(
        baseUrl,
        '/api/v1/channels/slack/infobip/webhook/T123',
        {},
      );

      expect(status).toBe(400);
      expect(body.error).toContain('Provider routing not supported');
    });
  });
});
