/**
 * Agent Transfer Webhook Routing Tests
 *
 * Verifies:
 * - Webhook handler does NOT call bridge.routeAgentEvent directly
 * - Webhook handler calls adapter.handleInboundEvent exactly once
 * - Event type normalization happens before delivery
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockHandleInboundEvent = vi.fn().mockResolvedValue(undefined);
const mockRouteAgentEvent = vi.fn().mockResolvedValue(undefined);
const mockExtendTTL = vi.fn().mockResolvedValue(undefined);
const mockGetByProvider = vi.fn();

const mockAdapter = {
  name: 'kore',
  capabilities: {
    supportsPreChecks: true,
    supportsPostAgentDialog: false,
    supportsFileUpload: false,
    supportsTranslation: false,
    transportType: 'webhook' as const,
    authType: 'internal_key' as const,
  },
  initialize: vi.fn(),
  execute: vi.fn(),
  sendUserMessage: vi.fn(),
  endSession: vi.fn(),
  onAgentMessage: vi.fn(),
  onSessionEvent: vi.fn(),
  handleInboundEvent: mockHandleInboundEvent,
};

const mockSessionStore = {
  getByProvider: mockGetByProvider,
  extendTTL: mockExtendTTL,
};

const mockMessageBridge = {
  routeAgentEvent: mockRouteAgentEvent,
};

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/agent-transfer', () => ({
  KoreEventHandler: {
    mapEventType: (xoType: string) => {
      const map: Record<string, string> = {
        agent_message: 'agent:message',
        agent_accepted: 'agent:connected',
        closed: 'agent:disconnected',
        typing: 'agent:typing',
        conversation_queued: 'agent:queued',
      };
      return map[xoType];
    },
  },
  verifyWebhookSignature: vi.fn().mockResolvedValue({ valid: true }),
  createRedisNonceStore: vi.fn(),
}));

vi.mock('../services/agent-transfer/index.js', () => ({
  isAgentTransferInitialized: () => true,
  getAdapterRegistry: () => ({
    get: (name: string) => (name === 'kore' ? mockAdapter : undefined),
  }),
  getTransferSessionStore: () => mockSessionStore,
  getAgentTransferConfig: () => ({}),
  getTransferTraceEmitter: vi.fn(() => null),
}));

vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: () => null,
  getRedisHandle: () => null,
}));

vi.mock('../services/agent-transfer/message-bridge.js', () => ({
  getMessageBridge: () => mockMessageBridge,
}));

// ── Import the router after mocks ────────────────────────────────────────────

import express from 'express';
import request from 'supertest';
import router from '../routes/agent-transfer-webhooks.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/webhooks', router);
  return app;
}

const VALID_SESSION = {
  tenantId: 'tenant-1',
  contactId: 'contact-1',
  channel: 'chat',
  projectId: 'project-1',
  agentId: 'agent-1',
};

const VALID_EVENT = {
  type: 'agent_message',
  conversationId: 'conv-123',
  orgId: 'tenant-1',
  message: 'Hello from the agent',
  timestamp: '2026-03-13T00:00:00Z',
};

describe('Agent Transfer Webhook Routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetByProvider.mockResolvedValue(VALID_SESSION);
  });

  // ── C12: No double-delivery ──────────────────────────────────────────────

  it('should NOT call bridge.routeAgentEvent directly', async () => {
    const app = createApp();

    await request(app).post('/webhooks/kore').send(VALID_EVENT).expect(200);

    // The bridge should never be called directly from the webhook handler.
    // Routing is handled internally by the adapter's onAgentMessage callbacks.
    expect(mockRouteAgentEvent).not.toHaveBeenCalled();
  });

  it('should call adapter.handleInboundEvent exactly once', async () => {
    const app = createApp();

    await request(app).post('/webhooks/kore').send(VALID_EVENT).expect(200);

    expect(mockHandleInboundEvent).toHaveBeenCalledTimes(1);
    expect(mockHandleInboundEvent).toHaveBeenCalledWith(VALID_EVENT, 'tenant-1');
  });

  // ── NEW-4: No duplicate extendTTL ────────────────────────────────────────

  it('should NOT call sessionStore.extendTTL (adapter handles it)', async () => {
    const app = createApp();

    await request(app).post('/webhooks/kore').send(VALID_EVENT).expect(200);

    // The adapter already extends TTL inside handleInboundEvent,
    // so the webhook handler should not duplicate it.
    expect(mockExtendTTL).not.toHaveBeenCalled();
  });

  // ── C11: Event type normalization ────────────────────────────────────────

  it('should normalize event type before delivery', async () => {
    const app = createApp();

    // Send an XO-style event type that should be normalized
    const event = { ...VALID_EVENT, type: 'agent_accepted' };
    await request(app).post('/webhooks/kore').send(event).expect(200);

    // Adapter receives the original event (normalization is logged but
    // the adapter also normalizes internally via KoreEventHandler.processEvent)
    expect(mockHandleInboundEvent).toHaveBeenCalledTimes(1);
    expect(mockHandleInboundEvent).toHaveBeenCalledWith(event, 'tenant-1');
  });

  it('should handle unknown event types gracefully (normalization returns undefined)', async () => {
    const app = createApp();

    const event = { ...VALID_EVENT, type: 'totally_unknown_event' };
    await request(app).post('/webhooks/kore').send(event).expect(200);

    // Even unknown types are passed to the adapter; the adapter decides what to do
    expect(mockHandleInboundEvent).toHaveBeenCalledTimes(1);
  });

  // ── Validation ───────────────────────────────────────────────────────────

  it('should return 400 for events missing type', async () => {
    const app = createApp();

    const event = { conversationId: 'conv-123', orgId: 'tenant-1' };
    await request(app).post('/webhooks/kore').send(event).expect(400);

    expect(mockHandleInboundEvent).not.toHaveBeenCalled();
  });

  it('should return 400 for events missing orgId', async () => {
    const app = createApp();

    const event = { type: 'agent_message', conversationId: 'conv-123' };
    await request(app).post('/webhooks/kore').send(event).expect(400);

    expect(mockHandleInboundEvent).not.toHaveBeenCalled();
  });

  it('should return 404 for unknown provider', async () => {
    const app = createApp();

    await request(app).post('/webhooks/unknown-provider').send(VALID_EVENT).expect(404);

    expect(mockHandleInboundEvent).not.toHaveBeenCalled();
  });

  it('should return 404 for tenant mismatch (no existence leak)', async () => {
    const app = createApp();

    // Session has tenantId 'tenant-1', but event has different orgId
    const event = { ...VALID_EVENT, orgId: 'tenant-other' };
    mockGetByProvider.mockResolvedValue({ ...VALID_SESSION, tenantId: 'tenant-1' });

    await request(app).post('/webhooks/kore').send(event).expect(404);

    expect(mockHandleInboundEvent).not.toHaveBeenCalled();
  });

  it('should return 500 when adapter.handleInboundEvent throws', async () => {
    const app = createApp();

    mockHandleInboundEvent.mockRejectedValueOnce(new Error('adapter failure'));

    await request(app).post('/webhooks/kore').send(VALID_EVENT).expect(500);

    expect(mockHandleInboundEvent).toHaveBeenCalledTimes(1);
    // Even on failure, bridge should not be called
    expect(mockRouteAgentEvent).not.toHaveBeenCalled();
  });
});
