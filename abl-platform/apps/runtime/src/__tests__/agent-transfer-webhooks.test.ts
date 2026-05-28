import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dependencies before importing the route
vi.mock('../services/agent-transfer/index.js', () => ({
  isAgentTransferInitialized: vi.fn(),
  getAdapterRegistry: vi.fn(),
  getTransferSessionStore: vi.fn(),
  getAgentTransferConfig: vi.fn().mockReturnValue(null),
  getTransferTraceEmitter: vi.fn(() => null),
}));

vi.mock('../services/agent-transfer/message-bridge.js', () => ({
  getMessageBridge: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/agent-transfer', () => ({
  verifyWebhookSignature: vi.fn(),
  createRedisNonceStore: vi.fn(),
  KoreEventHandler: {
    mapEventType: vi.fn((type: string) => type),
  },
}));

vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue(null),
  getRedisHandle: () => null,
}));

import express from 'express';
import request from 'supertest';
import webhookRouter from '../routes/agent-transfer-webhooks.js';
import {
  isAgentTransferInitialized,
  getAdapterRegistry,
  getTransferSessionStore,
} from '../services/agent-transfer/index.js';
import { getMessageBridge } from '../services/agent-transfer/message-bridge.js';

const mockIsInitialized = vi.mocked(isAgentTransferInitialized);
const mockGetRegistry = vi.mocked(getAdapterRegistry);
const mockGetSessionStore = vi.mocked(getTransferSessionStore);
const mockGetBridge = vi.mocked(getMessageBridge);

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/agent-transfer/webhooks', webhookRouter);
  return app;
}

describe('agent-transfer-webhooks', () => {
  let app: ReturnType<typeof createApp>;

  const mockAdapter = {
    name: 'kore',
    handleInboundEvent: vi.fn().mockResolvedValue(undefined),
    capabilities: { transportType: 'webhook' },
  };

  const mockSessionStore = {
    getByProvider: vi.fn(),
    extendTTL: vi.fn().mockResolvedValue(true),
  };

  const mockBridge = {
    routeAgentEvent: vi.fn().mockResolvedValue(undefined),
  };

  const mockRegistry = {
    get: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();

    mockIsInitialized.mockReturnValue(true);
    mockGetRegistry.mockReturnValue(mockRegistry as any);
    mockGetSessionStore.mockReturnValue(mockSessionStore as any);
    mockGetBridge.mockReturnValue(mockBridge as any);
    mockRegistry.get.mockReturnValue(mockAdapter);
  });

  const validEvent = {
    type: 'agent:message',
    conversationId: 'conv-123',
    orgId: 'tenant-1',
    message: 'Hello from agent',
    timestamp: '2026-03-06T12:00:00Z',
  };

  const validSession = {
    tenantId: 'tenant-1',
    contactId: 'contact-1',
    channel: 'chat',
    provider: 'kore',
    state: 'active',
  };

  it('processes valid provider event and delivers message', async () => {
    mockSessionStore.getByProvider.mockResolvedValue(validSession);

    const res = await request(app)
      .post('/api/v1/agent-transfer/webhooks/kore')
      .send(validEvent)
      .expect(200);

    expect(res.body).toEqual({ success: true });
    expect(mockSessionStore.getByProvider).toHaveBeenCalledWith('kore', 'tenant-1', 'conv-123');
    expect(mockAdapter.handleInboundEvent).toHaveBeenCalledWith(validEvent, 'tenant-1');
  });

  it('returns 503 when agent transfer is not initialized', async () => {
    mockIsInitialized.mockReturnValue(false);

    const res = await request(app)
      .post('/api/v1/agent-transfer/webhooks/kore')
      .send(validEvent)
      .expect(503);

    expect(res.body.error.code).toBe('NOT_INITIALIZED');
  });

  it('returns 404 for unknown provider', async () => {
    mockRegistry.get.mockReturnValue(undefined);

    const res = await request(app)
      .post('/api/v1/agent-transfer/webhooks/unknown')
      .send(validEvent)
      .expect(404);

    expect(res.body.error.code).toBe('UNKNOWN_PROVIDER');
  });

  it('returns 400 for malformed event (missing type)', async () => {
    const res = await request(app)
      .post('/api/v1/agent-transfer/webhooks/kore')
      .send({ conversationId: 'conv-1' })
      .expect(400);

    expect(res.body.error.code).toBe('INVALID_EVENT');
  });

  it('returns 400 for malformed event (missing conversationId)', async () => {
    const res = await request(app)
      .post('/api/v1/agent-transfer/webhooks/kore')
      .send({ type: 'agent:message' })
      .expect(400);

    expect(res.body.error.code).toBe('INVALID_EVENT');
  });

  it('returns 500 instead of hanging the socket when session lookup rejects', async () => {
    mockSessionStore.getByProvider.mockRejectedValueOnce(new Error('store unavailable'));

    const res = await request(app)
      .post('/api/v1/agent-transfer/webhooks/kore')
      .send(validEvent)
      .expect(500);

    expect(res.body.error.code).toBe('PROCESSING_ERROR');
  });

  it('returns 404 for unknown session', async () => {
    mockSessionStore.getByProvider.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/v1/agent-transfer/webhooks/kore')
      .send(validEvent)
      .expect(404);

    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns 404 on tenant mismatch (no leaking existence)', async () => {
    mockSessionStore.getByProvider.mockResolvedValue(validSession);

    const crossTenantEvent = { ...validEvent, orgId: 'other-tenant' };
    const res = await request(app)
      .post('/api/v1/agent-transfer/webhooks/kore')
      .send(crossTenantEvent)
      .expect(404);

    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns 400 when orgId is missing (tenant isolation required)', async () => {
    const eventNoOrg = { type: 'agent:message', conversationId: 'conv-123', message: 'Hi' };

    const res = await request(app)
      .post('/api/v1/agent-transfer/webhooks/kore')
      .send(eventNoOrg)
      .expect(400);

    expect(res.body.error.code).toBe('MISSING_TENANT');
  });

  it('handles adapter processing error gracefully', async () => {
    mockSessionStore.getByProvider.mockResolvedValue(validSession);
    mockAdapter.handleInboundEvent.mockRejectedValue(new Error('SmartAssist timeout'));

    const res = await request(app)
      .post('/api/v1/agent-transfer/webhooks/kore')
      .send(validEvent)
      .expect(500);

    expect(res.body.error.code).toBe('PROCESSING_ERROR');
  });

  it('works without message bridge (bridge not initialized)', async () => {
    mockSessionStore.getByProvider.mockResolvedValue(validSession);
    // Reset adapter mock since previous test may have set it to reject
    mockAdapter.handleInboundEvent = vi.fn().mockResolvedValue(undefined);
    mockGetBridge.mockReturnValue(null);

    const res = await request(app)
      .post('/api/v1/agent-transfer/webhooks/kore')
      .send(validEvent)
      .expect(200);

    expect(res.body).toEqual({ success: true });
    expect(mockAdapter.handleInboundEvent).toHaveBeenCalled();
  });
});
